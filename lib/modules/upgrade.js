const request = require('request')
const progress = require('request-progress')
const os = require('os')
const fs = require('fs-extra')
const childprocess = require('child_process')
const decompress = require('decompress')
const decompressTargz = require('decompress-targz')

const logger = require('./logger')
const config = require('../config/config')
const mqttc = require('./mqttc')
const helpers = require('./helpers')

/**
 * Upgrade Polyglot Module
 * @module modules/upgrade
 * @version 2.0
 */

 module.exports = {

  _inProgress: false,
  _filePath: 'https://s3.amazonaws.com/polyglotv2/binaries/',
  _fileName: {
   x86_64: 'polyglot-v2-linux-x64.tar.gz',
   armv6l: 'polyglot-v2-linux-armv6.tar.gz',
   armv7l: 'polyglot-v2-linux-armv7.tar.gz',
   darwin: 'polyglot-v2-osx-x64.tar.gz'
  },
  _upgradeTopic: 'udi/polyglot/frontend/upgrade',
  _stopUpgrade: false,

  upgrade(message) {
   if (message.hasOwnProperty('start')) {
     this.startUpgrade()
   } else if (message.hasOwnProperty('stop')) {
     this.stopUpgrade()
   }
  },

  startUpgrade() {
   if (this._inProgress) {
     logger.error('Upgrade: Frontend requested upgrade, however one is already in progress. Disallowing.')
     let response = {node: 'polyglot', start: { success: false, msg: 'Upgrade already in progress.'}}
     mqttc.publish(this._upgradeTopic, response)
   } else {
     if (__dirname.split('/')[1] === 'snapshot') {
       this._inProgress = true
       logger.info('Upgrade: Frontend requested upgrade. Proceeding.')
       let response = {node: 'polyglot', start: { success: true, msg: 'Upgrade starting.'}}
       mqttc.publish(this._upgradeTopic, response)
       this.getSystem()
     } else {
       let msg = 'You aren\'t running the binary Use git pull instead.'
       logger.info(`Upgrade: Frontend requested upgrade. ${msg}`)
       let response = {node: 'polyglot', start: { success: false, msg: msg}}
       mqttc.publish(this._upgradeTopic, response)
     }
   }
  },

  stopUpgrade() {
   let msg = ''
   let response = ''
   if (this._inProgress) {
     this._stopUpgrade = true
     msg = 'Attempting to stop upgrade by request.'
     response = {node: 'polyglot', stop: { success: true, msg: msg}}
   } else {
     msg = 'Can not stop upgrade. No upgrade in progress.'
     response = {node: 'polyglot', stop: { success: false, msg: msg}}
   }
   logger.info(`Upgrade: ${msg}`)
   mqttc.publish(this._upgradeTopic, response)
  },

  getSystem() {
   let platform = os.platform()
   let arch = null
   if (platform === 'darwin') {
     return this.download('darwin')
   } else if (platform === 'linux') {
     let value = childprocess.execSync('/usr/bin/env arch').toString()
     value = value.slice(0, value.length -1)
     return this.download(value)
   } else {
     let msg = `Platform not recognized - ${platform}`
     let response = {node: 'polyglot', start: { success: false, msg: msg}}
     logger.error(`Upgrade: ${msg}`)
     mqttc.publish(this._upgradeTopic, response)
     this._inProgress = false
   }
  },

  download(arch) {
   if (arch) {
     if (this._fileName.hasOwnProperty(arch)) {
       try {
         progress(request(this._filePath + this._fileName[arch]), {
           throttle: 500,
           //delay: 500
         })
         .on('progress', (state) => {
           mqttc.publish(this._upgradeTopic, {node: 'polyglot', progress: state})
           logger.debug(`Upgrade Progress: ${JSON.stringify(state)}`)
         })
         .on('error', (err) => {
           let msg = `Error: ${arch}`
           logger.error(`Upgrade: ${msg}`)
           let response = {node: 'polyglot', error: { msg: msg }}
           mqttc.publish(this._upgradeTopic, response)
           this._inProgress = false
           this._stopUpgrade = false
         })
         .on('end', () => {
           this._inProgress = false
           if (!this._stopUpgrade) {
             logger.info(`Upgrade: Download complete. Starting Install..`)
             this.extract(this._fileName[arch])
           } else {
             this._stopUpgrade = false
             logger.info('Stopped upgrade on users request.')
             if (fs.existsSync(this._fileName[arch])) fs.removeSync(this._fileName[arch])
           }
         })
         .pipe(fs.createWriteStream('./' + this._fileName[arch]))
       } catch (e) {
         logger.error('Upgrade: Error on download - ${e.message}')
       }
     } else {
       let msg = `No file for system type: ${arch}`
       logger.error(`Upgrade ${msg}`)
       let response = {node: 'polyglot', error: { msg: msg }}
       mqttc.publish(this._upgradeTopic, response)
     }
   } else {
     logger.error(`Upgrade: Failed to get system type.`)
   }
  },

  extract(file) {
   let base = file.split('.')[0]
   try {
     if (fs.existsSync(base)) fs.moveSync(base, base + '.old')
   } catch (e) {
     logger.error(`Upgrade: Move error - ${e.message}`)
   }
   try {
     decompress(file, '.', {
       plugins: [
         decompressTargz()
       ]
     }).then(() => {
       fs.removeSync(file)
       fs.removeSync(base + '.old')
       logger.info(`Upgrade: ${file} extracted.`)
       let msg = 'Upgrade Complete. Shutting Down in 5 seconds. SystemCTL or LaunchD should restart Polyglot automatically. If not, restart it manually. Logging you out. Wait for this message to disappear before attempting to log back in.'
       logger.info(msg)
       let response = {node: 'polyglot', complete: { msg: msg }}
       mqttc.publish(this._upgradeTopic, response)
       setTimeout(() => {
         helpers.shutdown()
       }, 5000)
     })
   } catch (e) {
     logger.error(`Upgrade: Extract error - ${e.message}`)
   }
  }

 }
