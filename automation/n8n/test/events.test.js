'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENT_TYPES } = require('../dist/nodes/shared/events.js');
const { events } = require('./helpers');

test('the trigger offers exactly the 18 documented event types, in order', () => {
	const expected = events().events;
	assert.equal(EVENT_TYPES.length, 18);
	assert.deepEqual(EVENT_TYPES.map((e) => e.value), expected.map((e) => e.type));
	for (const [i, e] of EVENT_TYPES.entries()) assert.equal(e.name.toLowerCase(), expected[i].label.toLowerCase());
});
