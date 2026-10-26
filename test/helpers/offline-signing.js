'use strict';

// Deliberately fictional constants. Set before loading signing/API modules so tests
// never use .educoder-keys.json or depend on the developer's environment.
const ak = '0123456789abcdef0123456789abcdef';
const sk = 'fedcba98765432100123456789abcdef';
const encode = (value) => Buffer.from(Buffer.from(value, 'ascii').toString('base64'), 'ascii').toString('base64');
process.env.EDUCODER_AK = encode(ak);
process.env.EDUCODER_SK = encode(sk);

module.exports = { ak, sk };
