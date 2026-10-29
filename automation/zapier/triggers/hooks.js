'use strict';
const { api } = require('../lib/api');
const { verify } = require('../lib/signature');
const { events, byType, TEST_EVENT } = require('../lib/events');

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** The raw body as sent. Zapier passes it in rawRequest.content; the parsed body re-serializes to the same bytes. */
function rawBody(bundle) {
  const raw = bundle.rawRequest || {};
  if (typeof raw.content === 'string' && raw.content.length) return raw.content;
  if (bundle.cleanedRequest && typeof bundle.cleanedRequest === 'object') {
    const { querystring, ...body } = bundle.cleanedRequest; // eslint-disable-line no-unused-vars
    return JSON.stringify(body);
  }
  return undefined;
}

/** Verifies the Standard Webhooks signature and returns the envelope, or null to drop the delivery. */
function verifiedPayload(z, bundle) {
  const secret = bundle.subscribeData && bundle.subscribeData.secret;
  const headers = (bundle.rawRequest && bundle.rawRequest.headers) || {};
  const body = rawBody(bundle);
  if (!verify(secret, headers, body)) {
    z.console.log('Keep Your Prompts: dropped a delivery whose webhook signature did not verify');
    return null;
  }
  return JSON.parse(body);
}

const subscribe = (eventsFor) => async (z, bundle) => {
  const zap = bundle.meta && bundle.meta.zap;
  const response = await z.request({
    url: api('/v1/webhooks'),
    method: 'POST',
    body: {
      url: bundle.targetUrl,
      events: eventsFor(bundle),
      description: `Zapier${zap && zap.name ? `: ${zap.name}` : zap && zap.id ? ` Zap ${zap.id}` : ''}`.slice(0, 200),
      source: 'zapier',
    },
  });
  // Zapier keeps this object (with the signing secret) as bundle.subscribeData.
  return response.data;
};

const unsubscribe = async (z, bundle) => {
  const id = bundle.subscribeData && bundle.subscribeData.id;
  if (!id) return {};
  const response = await z.request({
    url: api(`/v1/webhooks/${encodeURIComponent(id)}`),
    method: 'DELETE',
    skipThrowForStatus: true,
  });
  if (response.status !== 404) response.throwForStatus();
  return { id, deleted: true };
};

/** A sample envelope for the editor: the live example from GET /v1/webhooks/event-types. */
const sampleFor = async (z, type) => {
  const response = await z.request({ url: api('/v1/webhooks/event-types') });
  const entry = ((response.data && response.data.data) || []).find((e) => e.type === type);
  const example = entry && entry.example ? entry.example : byType[type].example;
  if (example && example.type && example.data) return example;
  return {
    id: `msg_sample_${type.replace('.', '_')}`,
    type,
    timestamp: new Date().toISOString(),
    version: 1,
    workspace: { id: 'sample' },
    test: true,
    data: example,
  };
};

function eventTrigger(event) {
  const key = event.type.replace('.', '_');
  return {
    key,
    noun: titleCase(event.group === 'inbox' ? 'capture' : event.type.split('.')[0]),
    display: {
      label: titleCase(event.label),
      description: `Triggers when ${lowerFirst(event.description).replace(/\.$/, '')}.`,
    },
    operation: {
      type: 'hook',
      performSubscribe: subscribe(() => [event.type]),
      performUnsubscribe: unsubscribe,
      perform: (z, bundle) => {
        const payload = verifiedPayload(z, bundle);
        if (!payload) return [];
        // "Send test event" can send any type to the endpoint: keep only this trigger's.
        return payload.type === event.type ? [payload] : [];
      },
      performList: async (z) => [await sampleFor(z, event.type)],
      sample: event.example,
    },
  };
}

const anyEvent = {
  key: 'any_event',
  noun: 'Event',
  display: {
    label: 'New Event',
    description: 'Triggers when any of the events you choose happens in your workspace.',
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'events',
        label: 'Events',
        required: true,
        list: true,
        choices: Object.fromEntries(events.map((e) => [e.type, `${titleCase(e.label)} (${e.type})`])),
        helpText: 'The events that trigger the Zap.',
      },
    ],
    performSubscribe: subscribe((bundle) => [].concat(bundle.inputData.events || [])),
    performUnsubscribe: unsubscribe,
    perform: (z, bundle) => {
      const payload = verifiedPayload(z, bundle);
      if (!payload) return [];
      const wanted = [].concat(bundle.inputData.events || []);
      return wanted.includes(payload.type) || payload.type === TEST_EVENT ? [payload] : [];
    },
    performList: async (z, bundle) => {
      const first = [].concat(bundle.inputData.events || [])[0] || 'prompt.version_saved';
      return [await sampleFor(z, first)];
    },
    sample: events[1].example,
  },
};

const triggers = [anyEvent, ...events.map(eventTrigger)];

module.exports = { triggers, verifiedPayload, rawBody };
