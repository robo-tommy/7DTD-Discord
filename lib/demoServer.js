const EventEmitter = require('events');

class DemoClient extends EventEmitter {}

const Client = new DemoClient();
exports.client = Client;

Client.connect = () => {
  Client.emit('ready');
};

Client.on('ready', () => {
  console.log('Demo client ready');
});
Client.emit('ready');

Client.exec = (command, callback) => {
  let response = '';

  switch (command) {
    case 'gettime':
      response = 'Day 1, 07:00\n6 days to next horde.';
      break;

    case 'version':
      response = 'Game version: Alpha 17 (b240) Compatibility Version: Alpha 17 (Simulated)';
      break;

    case 'lp':
      response = 'Total of 0 in the game';
      break;

    default:

  }

  callback(undefined, response);
};
