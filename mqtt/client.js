const MQTT = require('async-mqtt')
const get = require('get-value')
const fetch = require('node-fetch')
const winston = require('winston')
const DB = require('../db')
const config = require('../config')
const NotificationType = require('../enums/notification_type')
const HaDiscovery = require('./ha-discovery')

class MqttClient {

  async connect() {
    this.client = await MQTT.connectAsync(config.mqttUrl, {
      username: config.mqttUsername,
      password: config.mqttPassword,
      keepalive: 60,
      reconnectPeriod: 1000
    })

    this.client.on('error', error => {
      winston.error(`MQTT error`, { error })
    })

    this.client.on('reconnect', () => {
      winston.info(`MQTT reconnect`)
    })

    this.client.on('close', () => {
      winston.info('MQTT connection closed')
    })

    this.client.on('message', async (topic, message) => {
      winston.debug(`MQTT message: [${topic}]: ${message.toString()}`)
      if (topic === 'homeassistant/status') {
        if (message.toString() === 'online') {
          await this.setupAutoDiscovery()
        }
      }
    })

    try {
      await this.client.subscribe('homeassistant/status')
      winston.debug(`Subscribed to homeassistant/status`)
    } catch (e) {
      winston.error(`Error subscribing to homeassistant/status`, { exception: e })
    }
  }

  async setupAutoDiscovery () {
    const devices = await DB.getDevices()
    for (let device of devices) {
      const configs = HaDiscovery.discoveryConfigs(device)
      for (let config of configs) {
        await this.client.publish(config.topic, config.message)
      }
    }
  }

  async sendMotionDetectedEvent (device_sn, attributes) {
    await this.client.publish(`${HaDiscovery.motionDetectedBaseTopic(device_sn)}/state`, 'motion')
    await this.client.publish(`${HaDiscovery.motionDetectedBaseTopic(device_sn)}/attributes`, JSON.stringify(attributes))
  }

  async sendDoorbellPressedEvent (device_sn, attributes) {
    await this.client.publish(`${HaDiscovery.doorbellPressedBaseTopic(device_sn)}/state`, 'motion')
    await this.client.publish(`${HaDiscovery.doorbellPressedBaseTopic(device_sn)}/attributes`, JSON.stringify(attributes))
  }

  async sendCryingDetectedEvent (device_sn, attributes) {
    await this.client.publish(`${HaDiscovery.cryingDetectedBaseTopic(device_sn)}/state`, 'crying')
    await this.client.publish(`${HaDiscovery.cryingDetectedBaseTopic(device_sn)}/attributes`, JSON.stringify(attributes))
  }

  async processPushNotification (notification) {
    let type = parseInt(get(notification, 'payload.payload.event_type', { default: 0 }))
    if (type === 0) {
      type = parseInt(get(notification, 'payload.type', { default: 0 }))
    }
    if (type === 0) {
      let doorbellPayload = get(notification, 'payload.doorbell')
      // Doorbell (T8200) payload is a string; Parse to JSON and save in notification for later use.
      if (doorbellPayload) {
        try {
          let parsed = JSON.parse(doorbellPayload)
          notification.payload.doorbell = parsed
          type = parseInt(get(parsed, 'event_type', { default: 0 }))
        } catch (e) {
          winston.debug(`Error parsing doorbell payload`, e)
        }
      }
    }

    winston.debug(`Got Push Notification of type ${type}`)

    switch (type) {
      case NotificationType.DOORBELL_PRESSED:
        await this.doorbellEvent(notification)
        break
      case NotificationType.DOORBELL_SOMEONE_SPOTTED:
      case NotificationType.CAM_SOMEONE_SPOTTED:
      case NotificationType.CAM_2_SOMEONE_SPOTTED:
      case NotificationType.CAM_2C_SOMEONE_SPOTTED:
      case NotificationType.FLOODLIGHT_MOTION_DETECTED:
      case NotificationType.MOTION_SENSOR_TRIGGERED:
        await this.motionDetectedEvent(notification)
        break
      case NotificationType.CRYING_DETECTED:
        await this.cryingDetectedEvent(notification)
        break
    }
  }

  async doorbellEvent (event) {
    let device_sn = this.getDeviceSNFromEvent(event)
    if (!device_sn) {
      winston.warn(`Got doorbellEvent with unknown device_sn`, {event})
      return
    }

    const attributes = this.getAttributesFromEvent(event)

    try {
      await this.sendDoorbellPressedEvent(device_sn, attributes)
    } catch (e) {
      winston.error(`Failure in doorbellEvent`, { exception: e })
    }

    if (attributes.thumbnail) {
      await this.uploadThumbnail(device_sn, attributes.thumbnail)
    }
  }

  async motionDetectedEvent (event) {
    let device_sn = this.getDeviceSNFromEvent(event)
    if (!device_sn) {
      winston.warn(`Got motionDetectedEvent with unknown device_sn`, { event })
      return
    }

    const attributes = this.getAttributesFromEvent(event)

    try {
      await this.sendMotionDetectedEvent(device_sn, attributes)
    } catch (e) {
      winston.error(`Failure in motionDetectedEvent`, { exception: e })
    }

    if (attributes.thumbnail) {
      await this.uploadThumbnail(device_sn, attributes.thumbnail)
    }
  }

  async cryingDetectedEvent(event) {
    let device_sn = this.getDeviceSNFromEvent(event)
    if (!device_sn) {
      winston.warn(`Got cryingDetectedEvent with unknown device_sn`, { event })
      return
    }

    const attributes = this.getAttributesFromEvent(event)

    try {
      await this.sendCryingDetectedEvent(device_sn, attributes)
    } catch (e) {
      winston.error(`Failure in cryingDetectedEvent`, { exception: e })
    }

    if (attributes.thumbnail) {
      await this.uploadThumbnail(device_sn, attributes.thumbnail)
    }
  }

  async uploadThumbnail(device_sn, thumbnail_url) {
    winston.debug(`Uploading new thumbnail for ${device_sn} from ${thumbnail_url}`)
    const response = await fetch(thumbnail_url)
    const image = await response.buffer()

    const topic = HaDiscovery.thumbnailTopic(device_sn)

    await this.client.publish(topic, image)
  }

  getDeviceSNFromEvent (event) {
    let device_sn = get(event, 'payload.device_sn')
    if (!device_sn) {
      device_sn = get(event, 'payload.payload.device_sn')
      if (!device_sn) {
        device_sn = get(event, 'payload.doorbell.device_sn')
        if (!device_sn) {
          device_sn = get(event, 'payload.station_sn')
        }
      }
    }

    return device_sn
  }

  getAttributesFromEvent (event) {
    const attributes = {
      event_time: get(event, 'payload.event_time'),
      thumbnail: get(event, 'payload.payload.pic_url')
    }

    if (!attributes.event_time) {
      attributes.event_time = get(event, 'payload.doorbell.event_time')
    }
    if (!attributes.thumbnail) {
      attributes.thumbnail = get(event, 'payload.doorbell.pic_url')
    }

    return attributes
  }
}

module.exports = MqttClient
