// Renders a Keep Your Prompts template: {{name}} (spaces allowed inside the braces) is replaced by its value,
// {{{{ is a literal {{. `variables` is an array of {name, value} or a collection. `onMissing`: error | keep | empty.
// Same rules as the SDKs (protocol/README.md, "Templates") and conformance/cases.json.
function kypRender(template, variables, onMissing) {
	const vars = {};
	if (Array.isArray(variables)) {
		for (const v of variables) if (v && v.name) vars[String(v.name).trim()] = v.value;
	} else if (variables && typeof variables === 'object') {
		Object.assign(vars, variables);
	}
	const mode = onMissing || 'error';
	const t = String(template == null ? '' : template);
	const isStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
	const isIdent = (c) => isStart(c) || (c >= 48 && c <= 57);
	const isSpace = (c) => c === 32 || c === 9;
	let out = '';
	let i = 0;
	let run = 0;
	const missing = [];
	for (;;) {
		const open = t.indexOf('{{', i);
		if (open < 0) break;
		if (t.startsWith('{{{{', open)) {
			out += t.slice(run, open) + '{{';
			i = run = open + 4;
			continue;
		}
		let j = open + 2;
		while (j < t.length && isSpace(t.charCodeAt(j))) j++;
		if (j < t.length && isStart(t.charCodeAt(j))) {
			const start = j;
			while (j < t.length && isIdent(t.charCodeAt(j))) j++;
			const name = t.slice(start, j);
			while (j < t.length && isSpace(t.charCodeAt(j))) j++;
			if (t.startsWith('}}', j)) {
				out += t.slice(run, open);
				const v = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
				if (v !== undefined && v !== null) out += String(v);
				else if (mode === 'keep') out += t.slice(open, j + 2);
				else if (mode === 'error' && missing.indexOf(name) < 0) missing.push(name);
				i = run = j + 2;
				continue;
			}
		}
		i = open + 2;
	}
	out += t.slice(run);
	if (missing.length) throw new Error('Missing value for ' + missing.map((m) => '{{' + m + '}}').join(', '));
	return out;
}
