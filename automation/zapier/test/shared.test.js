/* globals describe, it, expect */
'use strict';
const { verify, sign } = require('../lib/signature');
const { renderTemplate, templateVariables, MissingVariablesError } = require('../lib/template');
const { events } = require('../lib/events');
const helpers = require('./helpers');

describe('Standard Webhooks shared vectors', () => {
  const v = helpers.vectors();
  for (const c of v.cases) {
    it(c.name, () => {
      expect(verify(c.secret, c.headers, c.body, c.now, v.toleranceSeconds)).toBe(c.valid);
    });
  }
  it('reproduces the specification signature', () => {
    const c = v.cases[0];
    expect(sign(c.secret, c.headers['webhook-id'], c.headers['webhook-timestamp'], c.body)).toBe(c.expectedSignature);
  });
  it('accepts Zapier-style Http- header names', () => {
    const c = v.cases[0];
    const zapierHeaders = {
      'Http-Webhook-Id': c.headers['webhook-id'],
      'Http-Webhook-Timestamp': c.headers['webhook-timestamp'],
      'Http-Webhook-Signature': c.headers['webhook-signature'],
    };
    expect(verify(c.secret, zapierHeaders, c.body, c.now)).toBe(true);
  });
});

describe('templates (conformance/cases.json)', () => {
  const cases = helpers.conformance();
  for (const c of cases.render) {
    it(`render ${JSON.stringify(c.template)}`, () => {
      if (c.error) {
        let err;
        try {
          renderTemplate(c.template, c.vars);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(MissingVariablesError);
        expect(err.missing).toContain(c.variable);
      } else {
        expect(renderTemplate(c.template, c.vars, c.lenient ? 'keep' : 'error')).toBe(c.out);
      }
    });
  }
  for (const c of cases.variables) {
    it(`variables ${JSON.stringify(c.template)}`, () => expect(templateVariables(c.template)).toEqual(c.out));
  }
});

describe('event catalogue', () => {
  it('is the shared catalogue of 18 events', () => {
    expect(events).toEqual(helpers.events().events);
    expect(events).toHaveLength(18);
  });
});
