<?php

declare(strict_types=1);

namespace KeepYourPrompts;

use KeepYourPrompts\Exception\ProtocolError;

/**
 * envs/<app>/<env>.json: which body is live for each prompt. Unknown fields are ignored.
 */
final class Manifest
{
    /**
     * @param array<string, ManifestPrompt> $prompts sorted by name
     */
    public function __construct(
        public readonly string $workspace,
        public readonly string $app,
        public readonly string $env,
        public readonly int $revision,
        public readonly string $deployedAt,
        public readonly array $prompts,
    ) {
    }

    /**
     * Parse and validate a manifest. When $app/$env are given, a manifest for another
     * app env is rejected.
     *
     * @throws ProtocolError
     */
    public static function parse(string $json, ?string $app = null, ?string $env = null): self
    {
        try {
            $j = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new ProtocolError('manifest is not valid JSON: ' . $e->getMessage());
        }
        if (!is_array($j) || ($j !== [] && array_is_list($j))) {
            throw new ProtocolError('manifest is not a JSON object');
        }
        if (array_key_exists('schema', $j) && $j['schema'] !== 1) {
            throw new ProtocolError('unsupported manifest schema (this SDK reads schema 1)');
        }
        $workspace = self::str($j, 'workspace', true);
        $mApp = self::str($j, 'app', true);
        $mEnv = self::str($j, 'env', true);
        $deployedAt = self::str($j, 'deployed_at', false);
        if (!self::isWorkspaceSlug($workspace)) {
            throw new ProtocolError('manifest workspace is not a valid slug');
        }
        if (($app !== null && $mApp !== $app) || ($env !== null && $mEnv !== $env)) {
            throw new ProtocolError(sprintf('manifest is for %s/%s, expected %s/%s', $mApp, $mEnv, $app ?? $mApp, $env ?? $mEnv));
        }
        $revision = $j['revision'] ?? null;
        if (!is_int($revision) || $revision < 0) {
            throw new ProtocolError('manifest "revision" must be a non-negative integer');
        }
        $raw = $j['prompts'] ?? null;
        if (!is_array($raw) || ($raw !== [] && array_is_list($raw))) {
            throw new ProtocolError('manifest "prompts" must be an object');
        }
        $prompts = [];
        foreach ($raw as $name => $p) {
            $name = (string) $name;
            if ($name === '' || $name[0] === '/' || str_ends_with($name, '/') || str_contains($name, '//')) {
                throw new ProtocolError(sprintf('invalid prompt name "%s"', $name));
            }
            if (!is_array($p)) {
                throw new ProtocolError(sprintf('prompt "%s" must be an object', $name));
            }
            $sha = $p['sha256'] ?? null;
            if (!is_string($sha)) {
                throw new ProtocolError(sprintf('prompt "%s" has no sha256', $name));
            }
            $sha = strtolower($sha);
            if (!self::isSha256Hex($sha)) {
                throw new ProtocolError(sprintf('prompt "%s" has an invalid sha256', $name));
            }
            $version = $p['version'] ?? 0;
            $vars = [];
            if (isset($p['variables']) && is_array($p['variables'])) {
                foreach ($p['variables'] as $v) {
                    if (is_string($v)) {
                        $vars[] = $v;
                    }
                }
            }
            $prompts[$name] = new ManifestPrompt($sha, is_int($version) ? $version : 0, $vars);
        }
        ksort($prompts, SORT_STRING);

        return new self($workspace, $mApp, $mEnv, $revision, $deployedAt, $prompts);
    }

    public static function isSlug(string $s): bool
    {
        return preg_match('/^[a-z0-9][a-z0-9-]{0,62}$/D', $s) === 1;
    }

    public static function isSha256Hex(string $s): bool
    {
        return preg_match('/^[0-9a-f]{64}$/D', $s) === 1;
    }

    public static function isWorkspaceSlug(string $s): bool
    {
        return $s !== '.' && $s !== '..' && preg_match('/^[A-Za-z0-9._-]{1,128}$/D', $s) === 1;
    }

    /**
     * @param array<mixed> $j
     */
    private static function str(array $j, string $key, bool $required): string
    {
        $v = $j[$key] ?? null;
        if ($v === null) {
            if ($required) {
                throw new ProtocolError(sprintf('manifest is missing "%s"', $key));
            }

            return '';
        }
        if (!is_string($v)) {
            throw new ProtocolError(sprintf('manifest "%s" must be a string', $key));
        }

        return $v;
    }
}
