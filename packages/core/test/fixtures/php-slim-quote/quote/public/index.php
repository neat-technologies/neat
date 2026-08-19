<?php
// Mirrors the otel-demo quote service: the app is built here (the PHP-DI Slim
// bridge, not AppFactory) and the routes live in a separate app/routes.php that is
// required and invoked. The route-declaring file, not this one, is where the routes
// are read — this file constructs the app but declares no route surface.

declare(strict_types=1);

use DI\Bridge\Slim\Bridge;
use DI\ContainerBuilder;

require __DIR__ . '/../vendor/autoload.php';

$container = (new ContainerBuilder())->build();
$app = Bridge::create($container);

$app->addRoutingMiddleware();

// Register routes
$routes = require __DIR__ . '/../app/routes.php';
$routes($app);

$app->addBodyParsingMiddleware();
$app->addErrorMiddleware(true, true, true);

$app->run();
