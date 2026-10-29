<?php

declare(strict_types=1);

namespace KeepYourPrompts\Laravel;

use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Container\Container;
use Illuminate\Support\ServiceProvider;
use KeepYourPrompts\KeepYourPrompts;

/**
 * Registers KeepYourPrompts as a singleton built from config('keepyourprompts')
 * (publish it with `php artisan vendor:publish --tag=keepyourprompts-config`),
 * falling back to the KYP_* environment variables. Auto-discovered.
 */
final class KeepYourPromptsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../../config/keepyourprompts.php', 'keepyourprompts');
        $this->app->singleton(KeepYourPrompts::class, static function (Container $app): KeepYourPrompts {
            $repository = $app->make('config');
            $config = [];
            if ($repository instanceof Repository) {
                $values = $repository->get('keepyourprompts', []);
                foreach (is_array($values) ? $values : [] as $key => $value) {
                    $config[(string) $key] = $value;
                }
            }
            if (($config['cache_dir'] ?? null) === null && getenv('KYP_CACHE_DIR') === false && method_exists($app, 'storagePath')) {
                $config['cache_dir'] = $app->storagePath('framework/cache/keepyourprompts');
            }

            return KeepYourPrompts::fromEnv($config);
        });
        $this->app->alias(KeepYourPrompts::class, 'keepyourprompts');
    }

    public function boot(): void
    {
        $this->publishes([__DIR__ . '/../../config/keepyourprompts.php' => $this->app->configPath('keepyourprompts.php')], 'keepyourprompts-config');
    }
}
