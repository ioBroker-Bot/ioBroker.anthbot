![Logo](admin/anthbot.png)
# ioBroker.anthbot

[![NPM version](https://img.shields.io/npm/v/iobroker.anthbot.svg)](https://www.npmjs.com/package/iobroker.anthbot)
[![Downloads](https://img.shields.io/npm/dm/iobroker.anthbot.svg)](https://www.npmjs.com/package/iobroker.anthbot)
![Number of Installations](https://iobroker.live/badges/anthbot-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/anthbot-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.anthbot.png?downloads=true)](https://nodei.co/npm/iobroker.anthbot/)

**Tests:** ![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.anthbot/workflows/Test%20and%20Release/badge.svg)

## anthbot adapter for ioBroker

Connect with Anthbot devices such as their robot mowers.

### Monitoring

Battery level is reported in the `elec` state. 

View a device's status in the `mode` state (charging, mowing, standby, etc).

The last status message & it's severity (event, error, etc) are shown in the `last_code`, `last_code_text` and `last_code_type` states. For users looking for more history, the `code_list` state holds a JSON array with the a larger number of messages.

The rest of the states should be self explanatory.

### Commands

`stop_all_tasks` equates to hiting 'Stop' in the Anthbot app.

`charge_start` equates to the 'Recharge' icon in the Anthbot app.

`mow_start` equates to start when in 'Full maps' mode.

`custom_area_mow_start` equates to start in custom area (aka 'Zones') mode. For this to work a valid list of area IDs must already be set in the `area_list` state. Area IDs are not the same as names the Anthbot app shows. Valid area IDs can be found in the `map.custom_areas.raw` state (this will be improved later).

Ie. to start mowing one or more zones:

- Set the `area_list` state to an array of IDs. Eg: `[102, 117]`
- Trigger the `custom_area_mow_start` state.

### Map & area (aka. zone) editing

With `area_set` it is possible to edit one or more areas. Take the JSON representation from a desired entry from the `map.custom_areas.raw_list`, modify it as required and save this the `area_set` state as a JSON array.

Note that when using `area_set` it is not necessary to define all parameters and only those provided will be changed. Eg: `[{"mow_head":10,"id":117}]` will change the angle of mowing in area 117 to 10 degrees and leave the other parameters as is.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
 - (raintonr) Added brief usage tips in readme
 - (raintonr) Added active_area, code_list, map states

### 0.0.4 (2026-05-18)
- (copilot) Adapter requires node.js >= 22 now
- (copilot) Adapter requires admin >= 7.7.22 now
- (raintonr) Handle temporary IoT access tokens (#9)

### 0.0.3 (2026-04-25)
* (raintonr) adapter checker issues

### 0.0.2 (2026-04-25)
* (raintonr) initial release

## License
MIT License


Copyright (c) 2026 iobroker-community-adapters <iobroker-community-adapters@gmx.de>  
Copyright (c) 2026 Robin Rainton <robin@rainton.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.