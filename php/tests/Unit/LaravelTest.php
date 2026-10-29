<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use Illuminate\Config\Repository;
use Illuminate\Container\Container;
use Illuminate\Support\Facades\Facade;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Laravel\Facades\Prompts;
use KeepYourPrompts\Laravel\KeepYourPromptsServiceProvider;
use KeepYourPrompts\Tests\Support\Fixtures;
use PHPUnit\Framework\TestCase;

final class LaravelTest extends TestCase
{
    protected function tearDown(): void
    {
        Facade::clearResolvedInstances();
        Facade::setFacadeApplication(null);
        Container::setInstance(null);
    }

    public function testServiceProviderAndFacade(): void
    {
        if (!class_exists(Container::class) || !class_exists(Repository::class)) {
            self::markTestSkipped('illuminate/container and illuminate/config are not installed');
        }
        $app = new Container();
        $app->instance('config', new Repository(['keepyourprompts' => [
            'app' => 'demo', 'snapshot_dir' => Fixtures::dir('v12'), 'store' => 'memory', 'log_level' => 'off',
        ]]));
        $provider = new KeepYourPromptsServiceProvider($app);
        $provider->register();

        $client = $app->make(KeepYourPrompts::class);
        self::assertInstanceOf(KeepYourPrompts::class, $client);
        self::assertSame($client, $app->make('keepyourprompts'), 'singleton');

        Facade::setFacadeApplication($app);
        self::assertSame('Hello Ana, welcome to Acme.', Prompts::render('greeting', ['name' => 'Ana', 'company' => 'Acme']));
        self::assertSame(12, Prompts::revision());
    }
}
