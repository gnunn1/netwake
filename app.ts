import Homey from 'homey';

module.exports = class NetWakeApp extends Homey.App {

  override async onInit(): Promise<void> {
    this.log('NetWake has been initialized');
  }

};
