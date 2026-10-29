it('fills variables, with spaces inside the braces', () => {
	assert.strictEqual(kypRender('Hi {{name}} from {{ company }}', [{ name: 'name', value: 'Ana' }, { name: 'company', value: 'Acme' }]), 'Hi Ana from Acme');
});

it('accepts a collection of variables', () => {
	assert.strictEqual(kypRender('{{a}}-{{b}}', { a: '1', b: 2 }), '1-2');
});

it('renders {{{{ as a literal {{', () => {
	assert.strictEqual(kypRender('use {{{{name}} syntax', []), 'use {{name}} syntax');
});

it('never renders a value again', () => {
	assert.strictEqual(kypRender('{{a}}', { a: '{{b}}', b: 'x' }), '{{b}}');
});

it('fails on a missing variable by default', () => {
	assert.throws(() => kypRender('{{missing}}', []));
});

it('keeps or empties a missing variable when asked', () => {
	assert.strictEqual(kypRender('{{missing}} stays', [], 'keep'), '{{missing}} stays');
	assert.strictEqual(kypRender('a{{missing}}b', [], 'empty'), 'ab');
});
