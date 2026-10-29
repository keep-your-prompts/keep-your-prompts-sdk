<?php

// Keep Your Prompts. Every value falls back to its KYP_* environment variable when null.
return [
    'app' => env('KYP_APP'),
    'env' => env('KYP_ENV', 'prod'),
    'delivery_key' => env('KYP_DELIVERY_KEY'),

    // A folder written by `kyp pull` (committed or baked into the image): start with zero network.
    'snapshot_dir' => env('KYP_SNAPSHOT_DIR'),
    // Disk cache in the protocol layout, shared with other processes and SDKs.
    // Default: storage/framework/cache/keepyourprompts.
    'cache_dir' => env('KYP_CACHE_DIR'),

    'git_mirror' => env('KYP_GIT_MIRROR'),
    'git_token' => env('KYP_GIT_TOKEN'),

    // Seconds between manifest revalidations (one request per interval per server does it).
    'poll_interval' => env('KYP_POLL_INTERVAL', 30),
    // auto (APCu when enabled, else a file), apcu, file, or memory (Octane/RoadRunner workers).
    'store' => env('KYP_STORE', 'auto'),
    // Revalidate after the response is sent (fastcgi_finish_request) instead of inline.
    'refresh_on_shutdown' => false,
    'start_empty' => false,
    'log_level' => env('KYP_LOG', 'warn'),
];
