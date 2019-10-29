// /// # Requirements and Initialization # /// //

// eslint-disable-next-line import/order
const pjson = require('./package.json');

console.log(`\x1b[7m# 7DTD Discord Integration v${pjson.version} #\x1b[0m`);
console.log('NOTICE: Remote connections to 7 Days to Die servers are not encrypted. To keep your server secure, do not run this application on a public network, such as a public wi-fi hotspot. Be sure to use a unique telnet password.\n');

const minimist = require('minimist');
const fs = require('fs');

const TelnetClient = require('telnet-client');

let channel;

const d7dtdState = {
  doReconnect: 1,

  waitingForTime: 0,
  waitingForVersion: 0,
  waitingForPlayers: 0,
  // waitingForPref: 0,
  receivedData: 0,

  skipVersionCheck: 0,

  // Connection initialized?
  connInitialized: 0,

  // Connection status
  // -1 = Error, 0 = No connection/connecting, 1 = Online
  // -100 = Override or N/A (value is ignored)
  connStatus: -100,
};

// //// # Arguments # //// //
// We have to treat the channel ID as a string or the number will parse incorrectly.
const argv = minimist(process.argv.slice(2), { string: ['channel', 'port'] });

// This is a simple check to see if we're using arguments or the config file.
// If the user is using arguments, config.json is ignored.

let configFileTmp = Object.keys(argv).length > 2
  ? undefined
  : 1;

if (typeof configFileTmp !== 'undefined') {
  configFileTmp = typeof argv.configFile === 'undefined'
    ? './config.json'
    : argv.configFile;
}

const configFile = configFileTmp;

const config = typeof configFile === 'undefined'
  ? argv
  // eslint-disable-next-line import/no-dynamic-require
  : require(configFile);

if (typeof configFile === 'undefined') {
  console.log('********\nWARNING: Configuring the bot with arguments is no-longer supported and may not work correctly. Please consider using config.json instead.\nThe arguments must be removed from run.bat/run.sh in order for the config file to take effect.\n********');
}

const Telnet = config['demo-mode']
  // eslint-disable-next-line import/order
  ? require('./lib/demoServer.js').client
  : new TelnetClient();

// IP
// This argument allows you to run the bot on a remote network.
const ip = typeof config.ip === 'undefined'
  ? 'localhost'
  : config.ip;

// Port
const port = typeof config.port === 'undefined'
  ? 8081
  : parseInt(config.port, 10);

// Telnet Password
if (typeof config.password === 'undefined') {
  console.error('\x1b[31mERROR: No telnet password specified!\x1b[0m');
  process.exit();
}
const pass = config.password;

// Discord token
if (typeof config.token === 'undefined') {
  console.error('\x1b[31mERROR: No Discord token specified!\x1b[0m');
  process.exit();
}
const { token } = config;

// Discord channel
const skipChannelCheck = (typeof config.channel === 'undefined' || config.channel === 'channelid');
if (skipChannelCheck) {
  console.warn('\x1b[33mWARNING: No Discord channel specified! You will need to set one with "setchannel #channelname"\x1b[0m');
}
let channelid = config.channel.toString();

// Prefix
const prefix = typeof config.prefix === 'string'
  ? config.prefix.toUpperCase()
  : '7d!';

// Load the Discord client
const Discord = require('discord.js');

const client = new Discord.Client();

// 7d!exec command
if (config['allow-exec-command'] === true) {
  console.warn('\x1b[33mWARNING: Config option "allow-exec-command" is enabled. This may pose a security risk for your server.\x1b[0m');
}

// /// # Init/Version Check # /// //
const configPrivate = {
  githubAuthor: 'LakeYS',
  githubName: '7DTD-Discord',
  socketPort: 7383
};

require('./lib/init.js')(pjson, config, configPrivate);

// /// # Functions # /// //
function handleMsgFromGame(line) {
  let split = line.split(' ');
  let type = split[3];

  if (typeof type !== 'undefined') {
    type = type.replace(':', '');
  }

  // TODO: Extra checks to make sure other lines do not leak.
  if (type !== 'INF' && type !== 'NET' && d7dtdState.waitingForMsg) {
    d7dtdState.waitingForMsg = 0;
    type = 'Chat'; // Manual override of type

    split = d7dtdState.waitingForMsgData.concat(split);
  }

  if (
    (config['disable-chatmsgs'] && type === 'Chat')
    || (config['disable-gmsgs'] && type === 'GMSG')
    || channel === null
  ) {
    return;
  }

  // Cut off the timestamp and other info
  let msg = split[4];
  const l = split.length - 1;
  for (let i = 5; i <= l; i += 1) {
    msg = `${msg} ${split[i]}`;
  }

  // Replace the source information
  if (type === 'Chat') {
    // For reasons unknown, sometimes messages are limited to exactly 64 characters.
    // Time for yet another band-aid workaround: Re-combining the message before sending it.
    if (line.length === 64) {
      d7dtdState.waitingForMsg = 1;
      d7dtdState.waitingForMsgData = split;

      return;
    }

    msg = msg.replace(/ *\([^)]*\): */, '');

    const checkString = "'Global'):";

    if (split[10] !== checkString && split[11] !== checkString) {
      if (config['show-private-chat']) {
        msg = `*(Private)* ${msg}`;
      } else {
        return;
      }
    }
  }

  if (config['log-messages']) {
    console.log(msg);
  }

  // When using a local connection, messages go through as new data rather than a response.
  // This string check is a workaround for that.
  if (msg.startsWith("'Server': [")) {
    return;
  }

  // Convert it to Discord-friendly text.
  msg = msg.replace("'", '').replace("'", '').replace('\n', '');

  if (type === 'GMSG') {
    // Remove join and leave messages.
    if (msg.endsWith('the game') && config['disable-join-leave-gmsgs']) {
      return;
    }

    // Remove other global messages (player deaths, etc.)
    if (!msg.endsWith('the game') && config['disable-misc-gmsgs']) {
      return;
    }
  }

  if (!config['hide-prefix'] && msg.includes(': /')) {
    // Do nothing if the prefix "/" is in the message.
    return;
  }

  channel.send(msg);
}

function handleMsgToGame(line) {
  // TODO: Ensure connection is valid before executing commands
  if (config['disable-chatmsgs']) {
    return;
  }

  Telnet.exec(`say "${line}"`, (err, response) => {
    if (err) {
      console.log(`Error while attempting to send message: ${err.message}`);
    } else {
      const lines = response.split('\n');
      const l = lines.length - 1

      for (let i = 0; i <= l; i += 1) {
        handleMsgFromGame(lines[i]);
      }
    }
  });
}

function handleCmdError(err) {
  if (!err) {
    return;
  }

  if (err.message === 'response not received') {
    channel.send('Command failed because the server is not responding. It may be frozen or loading.');
  } else if (err.message === 'socket not writable') {
    channel.send('Command failed because the bot is not connected to the server. Type 7d!info to see the current status.');
  } else {
    channel.send(`Command failed with error "${err.message}"`);
  }
}

function handleTime(line, msg) {
  const day = line.split(',')[0].replace('Day ', '');
  const dayHorde = (parseInt(day / 7, 10) + 1) * 7 - day;

  msg.channel.send(`${line}\n${dayHorde} day${dayHorde===1 ? '' : 's'} to next horde.`);
}

function handlePlayerCount(line, msg) {
  msg.channel.send(line);
}

// /// # Discord # /// //

// updateDiscordStatus
// NOTE: This function will 'cache' the current status to avoid re-sending it.
// If you want to forcibly re-send the same status, set 'd7dtdState.connStatus' to -100 first.
function updateDiscordStatus(status) {
  if (config['disable-status-updates']) {
    return;
  }

  if (status === 0 && d7dtdState.connStatus !== 0) {
    client.user.setActivity(`Connecting... | Type ${prefix}info`);
    client.user.setStatus('dnd');
  } else if (status === -1 && d7dtdState.connStatus !== -1) {
    client.user.setActivity(`Error | Type ${prefix}help`);
    client.user.setStatus('dnd');
  } else if (status === 1 && d7dtdState.connStatus !== 1) {
    if (typeof config.channel === 'undefined' || config.channel === 'channelid') {
      client.user.setActivity(`No channel | Type ${prefix}setchannel`);
      client.user.setStatus('idle');
    } else {
      client.user.setActivity(`7DTD | Type ${prefix}help`);
      client.user.setStatus('online');
    }
  }

  // Update the status so we don't keep sending duplicates to Discord
  d7dtdState.connStatus = status;
}

function refreshDiscordStatus() {
  const status = d7dtdState.connStatus;
  d7dtdState.connStatus = -100;
  updateDiscordStatus(status);
}

// This function prevent's the bot's staus from showing up as blank.
function d7dtdHeartbeat() {
  const status = d7dtdState.connStatus;
  d7dtdState.connStatus = -100;
  updateDiscordStatus(status);

  d7dtdState.timeout = setTimeout(() => {
    d7dtdHeartbeat();
  }, 3.6e+6); // Heartbeat every hour
}

function processTelnetResponse(response, callback) {
  // Sometimes the "response" has more than what we're looking for.
  // We have to double-check and make sure the correct line is returned.
  if (typeof response === 'undefined') {
    return;
  }

  d7dtdState.receivedData = 0;

  const lines = response.split('\n');
  const l = lines.length - 1;
  for (let i = 0; i <= l; i += 1) {
    callback(lines[i]);
  }
}

function parseDiscordCommand(msg, mentioned) {
  const cmd = msg.toString().toUpperCase().replace(prefix, '');

  if (msg.author.bot === true) {
    return;
  }

  // 7d!setchannel
  if (cmd.startsWith('SETCHANNEL')) {
    if (msg.channel.type === 'text' && channel !== null ? (msg.member.permissions.has('MANAGE_GUILD') && msg.guild === channel.guild) : 1) {
      console.log(`User ${msg.author.tag} (${msg.author.id}) executed command: ${cmd}`);
      const str = msg.toString().toUpperCase().replace(`${prefix}SETCHANNEL `, '');
      const id = str.replace('<#', '').replace('>', '');

      // If blank str, use active channel.
      const channelobj = id === `${prefix}SETCHANNEL`
        ? msg.channel
        : client.channels.find((obj) => (obj.id === id));

      if (channel !== null && channelobj.id === channel.id && typeof d7dtdState.setChannelError === 'undefined') {
        msg.channel.send(":warning: This channel is already set as the bot's active channel!");
        return;
      }

      if (channelobj !== null) {
        channel = channelobj;
        channelid = channel.id;

        config.channel = channelid;

        fs.writeFile(configFile, JSON.stringify(config, null, '\t'), 'utf8', (err) => {
          if (err) {
            console.error(`Failed to write to the config file with the following err:\n${err}\nMake sure your config file is not read-only or missing`);
            msg.channel.send(`:warning: Channel set successfully to <#${channelobj.id}> (${channelobj.id}), however the configuration has failed to save. The configured channel will not save when the bot restarts. See the bot's console for more info.`);
            d7dtdState.setChannelError = err;
          } else {
            d7dtdState.setChannelError = undefined;
            msg.channel.send(`:white_check_mark: The channel has been successfully set to <#${channelobj.id}> (${channelobj.id})`);
          }
        });

        refreshDiscordStatus();
      } else {
        msg.channel.send(':x: Failed to identify the channel you specified.');
      }
    } else {
      msg.author.send('You do not have permission to do this. (setchannel)');
    }
  }

  // 7d!exec
  // This command must be explicitly enabled due to the security risks of allowing it.
  if (config['allow-exec-command'] === true && cmd.startsWith('EXEC')) {
    if (msg.channel.type === 'text' && msg.member.permissions.has('MANAGE_GUILD') && msg.guild === channel.guild) {
      console.log(`User ${msg.author.tag} (${msg.author.id}) executed command: ${cmd}`);
      const execStr = msg.toString().replace(new RegExp(`${prefix}EXEC`, 'ig'), '');
      Telnet.exec(execStr);
    } else {
      msg.author.send('You do not have permission to do this. (exec)');
    }
  }

  // The following commands only work in the specified channel if one is set.
  if (msg.channel !== channel && msg.channel.type !== 'dm') {
    return;
  }

  // 7d!info
  if (cmd === 'INFO' || cmd === 'I' || cmd === 'HELP' || cmd === 'H' || mentioned) {
    // -1 = Error, 0 = No connection/connecting, 1 = Online, -100 = Override or N/A (value is ignored)
    let statusMsg;
    switch(d7dtdState.connStatus) {
      case -1:
        statusMsg = ':red_circle: Error';
        break;
      case 0:
        statusMsg = ':white_circle: Connecting...';
        break;
      case 1:
        statusMsg = ':large_blue_circle: Online';
        break;
      default:
        statusMsg = ':red_circle: Error Unknown Status';
    }

    let cmdString = '';
    if (!config['disable-commands']) {
      const pre = prefix.toLowerCase();
      cmdString = `\n**Commands:** ${pre}info, ${pre}time, ${pre}version, ${pre}players`;
    }


    const string = `Server connection: ${statusMsg}${cmdString}\n\n*7DTD-Discord v${pjson.version} - http://lakeys.net/discord7dtd - Powered by discord.js ${pjson.dependencies['discord.js'].replace('^', '')}.*`;
    msg.channel.send({embed: {
      description: string
    }})
      .catch(() => {
        // If the embed fails, try sending without it.
        msg.channel.send(string);
      });
  }

  // The following commands only work if disable-commands is OFF. (includes above conditions)
  // TODO: Refactor
  if (config['disable-commands']) {
    return;
  }

  // 7d!time
  if (cmd === 'TIME' || cmd === 'T' || cmd === 'DAY') {
    Telnet.exec('gettime', (err, response) => {
      if (err) {
        handleCmdError(err);
      } else {
        processTelnetResponse(response, (line) => {
          if (line.startsWith('Day')) {
            d7dtdState.receivedData = 1;
            handleTime(line, msg);
          }
        });

        // Sometimes, the response doesn't have the data we're looking for...
        if (!d7dtdState.receivedData) {
          d7dtdState.waitingForTime = 1;
          d7dtdState.waitingForTimeMsg = msg;
        }
      }
    });
  }

  // 7d!version
  if (cmd === 'VERSION' || cmd === 'V') {
    Telnet.exec('version', (err, response) => {
      if (err) {
        handleCmdError(err);
      } else {
        processTelnetResponse(response, (line) => {
          if (line.startsWith('Game version:')) {
            msg.channel.send(line);
            d7dtdState.receivedData = 1;
          }
        });

        if (!d7dtdState.receivedData) {
          d7dtdState.waitingForVersion = 1;
          d7dtdState.waitingForVersionMsg = msg;
        }
      }
    });
  }

  // 7d!players
  if (cmd === 'PLAYERS' || cmd === 'P' || cmd === 'PL' || cmd === 'LP') {
    Telnet.exec('lp', (err, response) => {
      if (err) {
        handleCmdError(err);
      } else {
        processTelnetResponse(response, (line) => {
          if (line.startsWith('Total of ')) {
            d7dtdState.receivedData = 1;
            handlePlayerCount(line, msg);
          }
        });

        if (!d7dtdState.receivedData) {
          d7dtdState.waitingForPlayers = 1;
          d7dtdState.waitingForPlayersMsg = msg;
        }
      }
    });
  }
  /*
  if (cmd === 'PREF') {
   Telnet.exec('getgamepref', (err, response) => {
     if (err) {
       handleCmdError(err);
     } else {
       // const str = msg.toString().toUpperCase().replace(`${prefix}PREF `, '').replace(`${prefix}PREF`, '');
       // Sometimes the "response" has more than what we're looking for.
       // We have to double-check and make sure the correct line is returned.
       if (typeof response !== 'undefined') {
         d7dtdState.receivedData = 0;

         const lines = response.split('\n');
         const l = lines.length - 1;

         let final = '';
         for (let i = 0; i <= l; i += 1) {
           const line = lines[i];
           if (line.startsWith('GamePref.')) {
             final = `${final}\n${line.replace('GamePref.', '')}`;
             d7dtdState.receivedData = 1;
           }
         }
         msg.author.send(final);
         msg.channel.send('Server configuration has been sent to you via DM.');
         // TODO: Make sure user can receive DMs before sending
       }

       if (!d7dtdState.receivedData) {
         d7dtdState.waitingForPref = 1;
         d7dtdState.waitingForPrefMsg = msg;
       }
     }
   });
  }
  */
}

// /// # Telnet # /// //
const params = {
  host: ip,
  port,
  timeout: 15000,
  username: '',
  password: pass,

  passwordPrompt: /Please enter password:/i,
  shellPrompt: /\r\n$/,

  debug: false,
};

// If Discord auth is skipped, we have to connect now rather than waiting for the Discord client.
if (config['skip-discord-auth']) {
  Telnet.connect(params);
}

Telnet.on('ready', () => {
  console.log(`Connected to game. (${Date()})`);

  if (!config['skip-discord-auth']) {
    updateDiscordStatus(1);
  }
});

Telnet.on('failedlogin', () => {
  console.log(`Login to game failed! (${Date()})`);
  process.exit();
});

Telnet.on('close', () => {
  console.log('Connection to game closed.');

  // If there is no error, update status to 'No connection'
  if (d7dtdState.connStatus !== -1) {
    updateDiscordStatus(0);
  }

  if (d7dtdState.doReconnect) {
    Telnet.end(); // Just in case
    setTimeout(() => { Telnet.connect(params); }, 5000);
  }
});

Telnet.on('data', (data) => {
  const dataStr = data.toString();

  if (config['debug-mode']) {
    console.log(`[DEBUG] Buffer length: ${dataStr.length}; Buffer dump: ${dataStr}`);
  }

  if (config['log-telnet']) {
    console.log(`[Telnet] ${dataStr}`);
  }

  // Error catchers for password re-prompts
  if (dataStr === 'Please enter password:\r\n\u0000\u0000') {
    console.log('ERROR: Received password prompt!');
    process.exit();
  }

  if (dataStr === 'Password incorrect, please enter password:\r\n') {
    console.log('ERROR: Received password prompt! (Telnet password is incorrect)');
    process.exit();
  }

  const lines = dataStr.split('\n');
  const l = lines.length - 1;

  const resendOnError = () => {
  // Try re-sending without the embed if an error occurs.
    channel.send('**The server has shut down.**')
      .catch((err) => {
        console.log(`Failed to send message with error: ${err.message}`);
      });
  };

  for (let i = 0; i <= l; i += 1) {
    const line = lines[i];

    // escapeRegExp
    lines[i] = lines[i].replace(/[.*+?^${}()|[\]\\]/g, ' ');

    const split = line.split(' ');

    if (split[2] === 'INF' && split[3] === '[NET]' && split[4] === 'ServerShutdown\r') {
      // If we don't destroy the connection, crashes will happen when someone types a message.
      // This is a workaround until better measures can be put in place for sending data to the game.
      console.log('The server has shut down. Closing connection...');
      Telnet.destroy();

      channel.send({embed: {
        color: 14164000,
        description: 'The server has shut down.'
      }})
        .catch(resendOnError);
    }

    // This is a workaround for responses not working properly, particularly on local connections.
    if (d7dtdState.waitingForTime && line.startsWith('Day')) {
      handleTime(line, d7dtdState.waitingForTimeMsg);
    } else if (d7dtdState.waitingForVersion && line.startsWith('Game version:')) {
      d7dtdState.waitingForVersionMsg.channel.send(line);
    } else if (d7dtdState.waitingForPlayers && line.startsWith('Total of ')) {
      d7dtdState.waitingForPlayersMsg.channel.send(line);
    // } else if (d7dtdState.waitingForPref && line.startsWith('GamePref.')) {
    //  d7dtdState.waitingForPrefMsg.channel.send(line);
    } else {
      handleMsgFromGame(line);
    }
  }
});

Telnet.on('error', (error) => {
  console.log(`An error occurred while connecting to the game:\n${error.message}`);
  // d7dtdState.lastTelnetErr = data.message;

  updateDiscordStatus(-1);
});

let firstLogin;
if (!config['skip-discord-auth']) {
  client.login(token);

  client.on('ready', () => {
    if (firstLogin !== 1) {
      firstLogin = 1;
      console.log('Discord client connected successfully.');

      // Set the initial status and begin the heartbeat timer.
      d7dtdState.connStatus = 0;
      d7dtdHeartbeat();
    } else {
      console.log('Discord client re-connected successfully.');

      // When the client reconnects, we have to re-establish the status.
      refreshDiscordStatus();
    }


    if (client.guilds.size === 0) {
      console.log(`\x1b[31m********\nWARNING: The bot is currently not in a Discord server. You can invite it to a guild using this invite link:\nhttps://discordapp.com/oauth2/authorize?client_id=${client.user.id}&scope=bot\n********\x1b[0m`);
    }

    if (client.guilds.size > 1) {
      console.log(`\x1b[31m********\nWARNING: The bot is currently in more than one guild. Please type 'leaveguilds' in the console to clear the bot from all guilds.\nIt is highly recommended that you verify 'Public bot' is UNCHECKED on this page:\n\x1b[1m https://discordapp.com/developers/applications/me/${client.user.id} \x1b[0m\n\x1b[31m********\x1b[0m`);
    }

    channel = client.channels.find((ch) => (ch.id === channelid));

    if (!channel && !skipChannelCheck) {
      console.log(`\x1b[33mERROR: Failed to identify channel with ID '${channelid}'\x1b[0m`);
    }

    // Wait until the Discord client is ready before connecting to the game.
    if (d7dtdState.connInitialized !== 1) {
      d7dtdState.connInitialized = 1; // Make sure we only do this once
      Telnet.connect(params);
    }
  });

  client.on('disconnect', (event) => {
    if (event.code === 1000) {
      return;
    }

    console.log(`Discord client disconnected with reason: ${event.reason} (${event.code}).`);

    if (event.code === 4004) {
      if (token === 'your_token_here') {
        console.log('It appears that you have not yet added a token. Please replace "your_token_here" with a valid token in the config file.');
      } else if (token.length < 50) {
        console.log('It appears that you have entered a client secret or other invalid string. Please ensure that you have entered a bot token and try again.');
      } else {
        console.log('Please double-check the configured token and try again.');
      }
      process.exit();
      return;
    }

    console.log('Attempting to reconnect in 6s...');
    setTimeout(() => { client.login(token); }, 6000);
  });

  client.on('error', (err) => {
    console.log(`Discord client error '${err.code}' (${err.message}). Attempting to reconnect in 6s...`);

    client.destroy();
    setTimeout(() => { client.login(config.token); }, 6000);
  });

  client.on('message', (msg) => {
    if (msg.author === client.user) {
      return;
    }

    // If the bot is mentioned, pass through as if the user typed 7d!info
    // Also includes overrides for the default prefix.
    const mentioned = msg.content.includes(`<@${client.user.id}>`) || msg.content === '7d!info' || msg.content === '7d!help';

    if (msg.content.toUpperCase().startsWith(prefix) || mentioned) {
      parseDiscordCommand(msg, mentioned);
    } else if (msg.channel === channel && msg.channel.type === 'text') {
      handleMsgToGame(`[${msg.author.username}] ${msg.cleanContent}`);
    }
  });
}

// /// # Console Input # /// //
process.stdin.on('data', (text) => {
  if (text.toString() === 'stop\r\n' || text.toString() === 'exit\r\n' || text.toString() === 'stop\n' || text.toString() === 'exit\n') {
    process.exit();
  } else if (text.toString() === 'help\r\n' || text.toString() === 'help\n') {
    console.log('This is the console for the Discord bot. It currently only accepts JavaScript commands for advanced users. Type "exit" to shut it down.');
  } else if (text.toString() === 'leaveguilds\r\n' || text.toString() === 'leaveguilds\n') {
    client.guilds.forEach((guild) => {
      console.log(`Leaving guild "${guild.name}"`);
      guild.leave();
    });
    console.log(`Left all guilds. Use this link to re-invite the bot: \n\x1b[1m https://discordapp.com/oauth2/authorize?client_id=${client.user.id}&scope=bot \x1b[0m`);
  } else {
    try {
      // eslint-disable-next-line no-eval
      eval(text.toString());
    } catch (err) {
      console.log(err);
    }
  }
});

process.on('exit',  () => {
  d7dtdState.doReconnect = 0;

  if (!config['skip-discord-auth']) {
    client.destroy();
  }
});

process.on('unhandledRejection', (err) => {
  if (config['skip-discord-auth']) {
    return;
  }

  console.log(`Unhandled rejection: "${err.message}". Attempting to reconnect...`);
  client.destroy();
  setTimeout(() => { client.login(token); }, 6000);
});
