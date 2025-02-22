/*    Copyright 2019-2023 Firewalla Inc.
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

const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const sysManager = require('./SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const asyncNative = require('../util/asyncNative.js');
const Message = require('./Message.js');
const NetworkProfile = require('./NetworkProfile.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_REFRESH = "LOCK_REFRESH_NETWORK_PROFILES";

const _ = require('lodash');

class NetworkProfileManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.networkProfiles = {};
    this.prefixMap = {}

    this.scheduleRefresh();

    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        log.info("Iptables is ready, apply network profile policies ...");
        this.scheduleRefresh();
        // destroy legacy backup chains from previous run
        setTimeout(() => {
          NetworkProfile.destroyBakChains().catch((err) => {});
        }, 60000);
      });

      sem.on("DeviceUpdate", (event) => {
        // notify NetworkProfile to discover more gateway's IPv6 addresses
        if (!sysManager.isIptablesReady())
          return;
        const host = event.host;
        let mac = host.mac;
        if (!mac)
          return;
        mac = mac.toUpperCase();
        if (_.isString(host.ipv4)) {
          const intfInfo = sysManager.getInterfaceViaIP(host.ipv4);
          if (intfInfo && host.ipv4 !== intfInfo.gateway)
            return;
          const uuid = intfInfo && intfInfo.uuid
          if (!uuid)
            return;
          const networkProfile = this.getNetworkProfile(uuid);
          if (!networkProfile)
            return;
          setTimeout(() => {
            networkProfile.rediscoverGateway6(mac);
          }, 3000);
        }
      });
    }

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("sys:network:info is reloaded, refreshing network profiles and policies ...");
      this.scheduleRefresh();
    });

    return this;
  }

  scheduleRefresh() {
    if (this.refreshTask)
      clearTimeout(this.refreshTask);
    this.refreshTask = setTimeout(() => {
      lock.acquire(LOCK_REFRESH, async () => {
        await this.updatePrefixMap()
        await this.refreshNetworkProfiles();
        if (f.isMain()) {
          if (sysManager.isIptablesReady()) {
            for (let uuid in this.networkProfiles) {
              const networkProfile = this.networkProfiles[uuid];
              await NetworkProfile.ensureCreateEnforcementEnv(uuid);
              networkProfile.scheduleApplyPolicy();
            }
            sem.sendEventToFireMain({
              type: Message.MSG_OSI_NETWORK_PROFILE_INITIALIZED,
              message: ""
            });
          }
        }
      }).catch((err) => {
        log.error("Failed to refresh network profiles", err);
      });
    }, 3000);
  }

  async toJson() {
    const json = {}
    for (let uuid in this.networkProfiles) {
      await this.networkProfiles[uuid].loadPolicyAsync();
      json[uuid] = this.networkProfiles[uuid].toJson();
    }
    return json;
  }

  getNetworkProfile(uuid) {
    return this.networkProfiles[uuid];
  }

  async scheduleUpdateEnv(networkProfile, updatedProfileObject) {
    await sysManager.waitTillIptablesReady()

    // use old network profile config to destroy old environment
    log.info(`Destroying environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
    await networkProfile.destroyEnv();
    await networkProfile.update(updatedProfileObject);
    // use new network profile config to create new environment
    log.info(`Creating environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
    await networkProfile.createEnv();
  }

  _isNetworkProfileChanged(then, now) {
    const thenCopy = JSON.parse(JSON.stringify(then));
    const nowCopy = JSON.parse(JSON.stringify(now));
    for (let key in thenCopy) {
      if (_.isArray(thenCopy[key]))
      thenCopy[key] = thenCopy[key].sort();
    }
    for (let key in nowCopy) {
      if (_.isArray(nowCopy[key]))
      nowCopy[key] = nowCopy[key].sort();
    }
    // in case there is any key to exclude in future
    const excludedKeys = ["active", "pendingTest", "origDns", "origDns6", "pds"]; // no need to consider change of original dns
    for (const excludedKey of excludedKeys) {
      if (thenCopy.hasOwnProperty(excludedKey))
        delete thenCopy[excludedKey];
      if (nowCopy.hasOwnProperty(excludedKey))
        delete nowCopy[excludedKey];
    }
    return !_.isEqual(thenCopy, nowCopy);
  }

  async updatePrefixMap() {
    try {
      const UUIDs = await rclient.hkeysAsync('sys:network:uuid')
      for (const uuid of UUIDs) {
        if (uuid.length >= 32)
          this.prefixMap[uuid.substring(0, 8)] = uuid
      }
    } catch(err) {
      log.error('Failed to update UUID prefix map', err)
    }
  }

  async refreshNetworkProfiles(readOnly = false) {
    if (f.isMain() && readOnly) // only return cached networkProfiles to avoid race condition on updating this.networkProfiles
      return this.networkProfiles;
    const markMap = {};
    const keys = await rclient.keysAsync("network:uuid:*");
    for (let key of keys) {
      const redisProfile = await rclient.hgetallAsync(key);
      if (!redisProfile) // just in case
        continue;
      const o = NetworkProfile.parse(redisProfile);
      const uuid = key.substring(13);
      if (!uuid) {
        log.info(`uuid is not defined, ignore this interface`, o);
        continue;
      }
      o.uuid = uuid;
      if (this.networkProfiles[uuid]) {
        const networkProfile = this.networkProfiles[uuid];
        const changed = this._isNetworkProfileChanged(networkProfile.o, o);
        if (changed) {
          // network profile changed, need to reapply createEnv
          if (f.isMain() && !readOnly) {
            log.info(`Network profile of ${uuid} ${networkProfile.o.intf} is changed, updating environment ...`, o);
            await this.scheduleUpdateEnv(networkProfile, o);
          }
        }
        await networkProfile.update(o);
      } else {
        this.networkProfiles[uuid] = new NetworkProfile(o);
        if (f.isMain() && !readOnly) {
          await this.scheduleUpdateEnv(this.networkProfiles[uuid], o);
        }
      }
      markMap[uuid] = false;
    }

    const monitoringInterfaces = sysManager.getMonitoringInterfaces() || [];
    const logicInterfaces = sysManager.getLogicInterfaces() || [];
    for (let intf of logicInterfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.info(`uuid is not defined, ignore this interface`, intf);
        continue;
      }
      const monitoring = monitoringInterfaces.some(i => i.name === intf.name);
      const updatedProfile = {
        uuid: uuid,
        intf: intf.name,
        ipv4Subnet: intf.subnet,
        ipv4: intf.ip_address,
        ipv4Subnets: intf.ip4_subnets || [],
        ipv4s: intf.ip4_addresses || [],
        ipv6: intf.ip6_addresses || [],
        ipv6Subnets: intf.ip6_subnets || [],
        dns: intf.dns || [],
        dns6: intf.dns6 || [],
        gateway: intf.gateway_ip || "",
        gateway6: intf.gateway6 || "",
        monitoring: monitoring,
        type: intf.type || "",
        rtid: intf.rtid || 0,
        rt4Subnets: intf.rt4_subnets || [],
        rt6Subnets: intf.rt6_subnets || []
      };
      if (intf.hasOwnProperty("vendor"))
        updatedProfile.vendor = intf.vendor;
      if (intf.hasOwnProperty("ready"))
        updatedProfile.ready = intf.ready;
      if (intf.hasOwnProperty("active"))
        updatedProfile.active = intf.active;
      if (intf.hasOwnProperty("pendingTest"))
        updatedProfile.pendingTest = intf.pendingTest;
      if (intf.hasOwnProperty("essid"))
        updatedProfile.essid = intf.essid;
      if (intf.hasOwnProperty("origDns"))
        updatedProfile.origDns = intf.origDns;
      if (intf.hasOwnProperty("origDns6"))
        updatedProfile.origDns6 = intf.origDns6;
      if (intf.hasOwnProperty("pds"))
        updatedProfile.pds = intf.pds;
      if (!this.networkProfiles[uuid]) {
        this.networkProfiles[uuid] = new NetworkProfile(updatedProfile);
        if (f.isMain() && !readOnly) {
          await this.scheduleUpdateEnv(this.networkProfiles[uuid], updatedProfile);
        }
      } else {
        const networkProfile = this.networkProfiles[uuid];
        const changed = this._isNetworkProfileChanged(networkProfile.o, updatedProfile);
        if (changed) {
          // network profile changed, need to reapply createEnv
          if (f.isMain() && !readOnly) {
            log.info(`Network profile of ${uuid} ${networkProfile.o.intf} is changed, updating environment ......`, updatedProfile);
            await this.scheduleUpdateEnv(networkProfile, updatedProfile);
          }
        }
        await networkProfile.update(updatedProfile);
      }
      markMap[uuid] = true;
    }

    const removedNetworkProfiles = {};
    Object.keys(this.networkProfiles).filter(uuid => markMap[uuid] !== true).map((uuid) => {
      removedNetworkProfiles[uuid] = this.networkProfiles[uuid];
    });
    for (let uuid in removedNetworkProfiles) {
      if (f.isMain() && !readOnly) (async () => {
        await rclient.unlinkAsync(`network:uuid:${uuid}`);
        await sysManager.waitTillIptablesReady()
        log.info(`Destroying environment for network ${uuid} ${removedNetworkProfiles[uuid].o.intf} ...`);
        await removedNetworkProfiles[uuid].destroyEnv({cleanup: true});
        await removedNetworkProfiles[uuid].destroy();
        await dnsmasq.writeAllocationOption(removedNetworkProfiles[uuid].o.intf, {})
      })()
      delete this.networkProfiles[uuid];
    }

    for (let uuid in this.networkProfiles) {
      const key = `network:uuid:${uuid}`;
      const networkProfile = this.networkProfiles[uuid];
      if (f.isMain() && !readOnly) {
        const newObj = networkProfile.redisfy();
        const removedKeys = (await rclient.hkeysAsync(key) || []).filter(k => !Object.keys(newObj).includes(k));
        if (removedKeys && removedKeys.length > 0)
          await rclient.hdelAsync(key, removedKeys);
        await rclient.hmsetAsync(key, newObj);
      }
    }
    this.initialized = true;
    return this.networkProfiles;
  }

  isInitialized() {
    return this.initialized === true;
  }

  async loadPolicyRules() {
    await asyncNative.eachLimit(Object.values(this.networkProfiles), 10, np => np.loadPolicyAsync())
  }
}

const instance = new NetworkProfileManager();
module.exports = instance;
