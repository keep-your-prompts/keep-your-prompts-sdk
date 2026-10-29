'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate, templateVariables, MissingVariablesError } = require('../dist/nodes/shared/template.js');
const { conformance } = require('./helpers');

const cases = conformance();

for (const c of cases.render) {
	test(`conformance render: ${JSON.stringify(c.template)}`, () => {
		if (c.error) {
			assert.throws(() => renderTemplate(c.template, c.vars), (e) => e instanceof MissingVariablesError && e.missing.includes(c.variable));
		} else {
			assert.equal(renderTemplate(c.template, c.vars, c.lenient ? 'keep' : 'error'), c.out);
		}
	});
}

for (const c of cases.variables) {
	test(`conformance variables: ${JSON.stringify(c.template)}`, () => {
		assert.deepEqual(templateVariables(c.template), c.out);
	});
}

test('onMissing empty drops unknown variables', () => {
	assert.equal(renderTemplate('a{{x}}b', {}, 'empty'), 'ab');
});
