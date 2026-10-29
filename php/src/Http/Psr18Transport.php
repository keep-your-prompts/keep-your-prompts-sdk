<?php

declare(strict_types=1);

namespace KeepYourPrompts\Http;

use KeepYourPrompts\Exception\TransportException;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;

/**
 * Adapter for any PSR-18 client (Guzzle, Symfony HttpClient's Psr18Client, ...).
 * Timeouts are whatever the client was configured with; set them low (a few seconds).
 * Requires psr/http-client and psr/http-factory, which the SDK itself does not.
 */
final class Psr18Transport implements Transport
{
    public function __construct(
        private readonly ClientInterface $client,
        private readonly RequestFactoryInterface $requests,
    ) {
    }

    public function get(string $url, array $headers, float $connectTimeout, float $timeout): Response
    {
        $request = $this->requests->createRequest('GET', $url);
        foreach ($headers as $k => $v) {
            $request = $request->withHeader($k, $v);
        }
        try {
            $response = $this->client->sendRequest($request);
        } catch (ClientExceptionInterface $e) {
            throw new TransportException($e->getMessage(), 0, $e);
        }
        $out = [];
        foreach ($response->getHeaders() as $name => $values) {
            $out[strtolower((string) $name)] = implode(', ', $values);
        }

        return new Response($response->getStatusCode(), (string) $response->getBody(), $out);
    }
}
