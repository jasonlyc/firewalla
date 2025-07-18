/*    Copyright 2020 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const exec = require('child-process-promise').exec;
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const f = require('../../net2/Firewalla.js');
const log = require('../../net2/logger.js')(__filename);
const util = require('../../util/util.js');

const dockerDir = `${f.getRuntimeInfoFolder()}/docker/freeradius`
const configDir = `${f.getHiddenFolder()}/config/freeradius`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let instance = null;

class FreeRadius {
  constructor(config) {
    if (instance === null) {
      instance = this;
      this.config = config || {};
      this.running = false;
      this.watcher = null;
      this.pid = null;
    }
    return instance;
  }

  async prepare() {
    await this.watchContainer();
    this.startDockerDaemon();
  }

  async _watchStatus() {
    await exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
  }

  async watchContainer(interval) {
    if (this.watcher) {
      clearInterval(this.watcher);
    }
    await exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
    this.watcher = setInterval(() => {
      exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
    }, interval * 1000 || 60000); // every 60s by default
  }

  async startDockerDaemon() {
    let dockerRunning = false;
    if (await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false)) {
      dockerRunning = true;
      return true;
    }
    log.info("Starting docker service...")
    const watcher = setInterval(() => {
      exec(`sudo systemctl -q is-active docker`).then(() => { dockerRunning = true }).catch((err) => { dockerRunning = false });
    }, 10000);
    await exec(`sudo systemctl start docker`).catch((err) => { });
    await util.waitFor(_ => dockerRunning === true, 30000).then(() => true).catch((err) => false);
    clearInterval(watcher);
    return dockerRunning
  }

  async startServer(options = {}) {
    this.watchContainer(5);
    await this._startServer(options);
    this.watchContainer(60);
    await this._statusServer();
  }

  async _startServer(options = {}) {
    if (this.running) {
      log.warn("Abort starting radius-server, server is already running.")
      return false;
    }
    log.debug("Starting container freeradius-server...");
    try {
      if (!await this.generateRadiusConfig()) {
        log.warn("Abort starting radius-server, configuration not ready");
        return false;
      }
      if (!await this._start()) {
        return false;
      }
      await util.waitFor(_ => this.running === true, options.timeout * 1000 || 60000).catch((err) => { });
      if (!this.running) {
        log.warn("Container freeradius-server is not started.")
        return false;
      }
      log.info("Container freeradius-server is started.");
      return true;
    } catch (err) {
      log.warn("Failed to start radius-server,", err.message);
    }
    return false;
  }

  async _start() {
    if (!await this.startDockerDaemon()) {
      log.error("Docker daemon is not running.");
      return false;
    }
    await exec("sudo systemctl start docker-compose@freeradius").catch((e) => {
      log.warn("Cannot start freeradius,", e.message);
      return false;
    });
    return true;
  }

  async generateOptions(options = {}) {
    const configPath = `${configDir}/.freerc`;
    // remove existing file
    if (await fs.accessAsync(configPath, fs.constants.F_OK).then(() => true).catch(_err => false)) {
      await fs.unlinkAsync(configPath);
    }
    // generate new file
    const lines = Object.entries(options).map(([key, value]) => `${key}=${value}`);
    const content = lines.join("\n");
    await fs.writeFileAsync(configPath, content);
    return true;
  }

  async generateRadiusConfig() {
    try {
      const configPath = `${configDir}/freeradius.js`;
      if (!await fs.accessAsync(configPath, fs.constants.F_OK).then(() => true).catch(_err => false)) {
        log.warn("freeradius config scripts not exist");
        return false;
      }

      const nodePath = await this.getNodePath();
      if (!nodePath) {
        log.warn("Cannot get generate radius config, node binary not found")
        return "";
      }
      await exec(`NODE_PATH="${f.getUserHome()}/.node_modules/node_modules" ${nodePath} ${configPath} generate > ${f.getUserHome()}/logs/freeradius.log 2>&1`)
      return true;
    } catch (err) {
      log.warn("Failed to generate radius config,", err.message);
      return false;
    }
  }

  async loadOptionsAsync() {
    const options = {};
    // Load environment file if .freerc` exists in working directory
    if (await fs.accessAsync(`${configDir}/.freerc`).then(() => true).catch(() => false)) {
      try {
        const envContent = await fs.readFileAsync(`${configDir}/.freerc`, 'utf8');
        const envLines = envContent.split('\n').filter(line =>
          line.trim() && !line.trim().startsWith('#')
        );
        for (const line of envLines) {
          const [key, value] = line.split('=');
          if (key && value) options[key] = value;
        }
      } catch (error) {
        console.warn(`Warning: Could not read environment file: ${error.message}`);
      }
    }
    return options;
  }

  async getNodePath() {
    try {
      const result = await exec(`sudo -u pi bash -c "source ~/.nvm/nvm.sh && which node"`).then(r => r.stdout.trim());
      if (result) return result;
    } catch (err) {
      log.warn("Cannot get node path via nvm as pi user,", err.message);
    }
  }

  async reloadServer(options = {}) {
    this.watchContainer(5);
    await this._reloadServer(options);
    this.watchContainer(60);
    await this._statusServer();
  }

  // TODO: will not reload clients, need to check changes
  async _reloadServer(options = {}) {
    try {
      if (!await this.generateRadiusConfig()) {
        log.warn("Abort starting radius-server, configuration not ready");
        return false;
      }
      log.info("Reloading container freeradius-server...");

      await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml kill -s SIGHUP freeradius`).catch((e) => {
        log.warn("Cannot reload freeradius,", e.message)
        // comment out to keep for debug
        // return false;
      });
      await sleep(3000);
      await util.waitFor(_ => this.running === true, options.timeout * 1000 || 60000).catch((err) => { });
      log.info("Container freeradius-server is reloaded.");
      return this.running;
    } catch (err) {
      log.warn("Failed to reload radius-server,", err.message);
    }
    return false;
  }

  async _statusServer() {
    try {
      this.pid = null;
      log.info("Checking status of container freeradius-server...");
      await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml ps`).catch((e) => {
        log.warn("Cannot check status of freeradius,", e.message)
      });

      const result = await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml exec -T freeradius pidof freeradius`).then(r => r.stdout.trim()).catch((e) => {
        log.warn("Cannot check status of freeradius,", e.message)
        return;
      });
      if (result) {
        log.info("Container freeradius-server is running, pid:", result);
        this.pid = result;
        return;
      }
      log.info("Container freeradius-server is not running.");
    } catch (err) {
      log.warn("Failed to check status of radius-server,", err.message);
    }
  }

  async stopServer(options = {}) {
    this.watchContainer(5);
    await this._stopServer(options);
    this.watchContainer(60);
    await this._statusServer();
  }

  async _stopServer(options = {}) {
    try {
      log.info("Stopping container freeradius-server...");
      await exec("sudo systemctl stop docker-compose@freeradius").catch((e) => {
        log.warn("Cannot stop freeradius,", e.message)
      });
      await util.waitFor(_ => this.running === false, options.timeout * 1000 || 60000).catch((err) => { });
      if (this.running) {
        log.warn("Container freeradius-server is not stopped.")
        return
      }
      log.info("Container freeradius-server is stopped.");
    } catch (err) {
      log.warn("Failed to stop radius-server,", err.message);
    }
  }

  async reconfigServer(options = {}) {
    this.watchContainer(5);
    if (options.quickReload) {
      await this._reloadServer(options);
    } else {
      await this._stopServer(options);
      if (!await this._startServer(options)) {
        return false;
      }
      this.watchContainer(60);
      return this.running;
    }
  }

  // radius listens on 1812-1813
  async isListening() {
    return await exec("netstat -an | egrep -q ':1812'").then(() => true).catch((err) => false);
  }

  getStatus() {
    return { running: this.running, pid: this.pid };
  }

}

module.exports = new FreeRadius();
