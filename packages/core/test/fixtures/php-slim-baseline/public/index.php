<?php

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;

require __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

$app->post('/getquote', function (Request $request, Response $response) {
    $response->getBody()->write('quote');
    return $response;
});

// A route modifier chained after the verb doesn't change the template.
$app->get('/health', function (Request $request, Response $response) {
    return $response;
})->setName('health');

// The multi-method map form — one route per listed method.
$app->map(['GET', 'POST'], '/echo', function (Request $request, Response $response) {
    return $response;
});

// The method-agnostic `any` maps to ALL.
$app->any('/any', function (Request $request, Response $response) {
    return $response;
});

// A route group composes its prefix; a nested group composes again.
$app->group('/api', function ($group) {
    $group->get('/status', function (Request $request, Response $response) {
        return $response;
    });
    $group->group('/v1', function ($g) {
        $g->post('/orders', function (Request $request, Response $response) {
            return $response;
        });
    });
});

$app->run();
