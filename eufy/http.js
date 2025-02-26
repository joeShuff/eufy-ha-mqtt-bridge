const { HttpService } = require('eufy-node-client')
const winston = require('winston')
const get = require('get-value')
const DB = require('../db')
const { supportedDevices } = require('../enums/device_type')

class EufyHttp {
  constructor (username, password) {
    this.httpService = new HttpService(username, password)
  }

  async refreshDevices () {
    const devices = await this.httpService.listDevices()
    winston.silly(`Device list: `, devices)
    for (let device of devices) {
      await DB.createOrUpdateDevice(device)
      const deviceType = get(device, 'device_model', { default: null })

      winston.info(`Stored device: ${device.device_name} (${device.device_sn} - type: ${deviceType})`)

      if (!supportedDevices.includes(deviceType)) {
        winston.warn(`DEVICE ${device.device_name} NOT SUPPORTED! See: https://github.com/matijse/eufy-ha-mqtt-bridge/issues/7`)
      }
    }
  }

  async registerPushToken (fcmToken) {
    const response = await this.httpService.registerPushToken(fcmToken);
    winston.info(`Registered Push Token`, { response })
  }

  async checkPushToken () {
    const response = await this.httpService.pushTokenCheck()
    winston.info(`Checked Push Token`, { response })
  }
}

module.exports = EufyHttp
