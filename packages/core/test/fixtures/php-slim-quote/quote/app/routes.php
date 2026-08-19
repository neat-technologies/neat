<?php
// The otel-demo quote service registers its route here, on a `$app` typed `Slim\App`
// that public/index.php passes in — the Slim-skeleton shape. This file constructs no
// app of its own; the `App` type hint is the only local Slim signal.

declare(strict_types=1);

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Slim\App;

return function (App $app) {
    $app->post('/getquote', function (Request $request, Response $response, LoggerInterface $logger) {
        $data = $request->getParsedBody();
        $response->getBody()->write(json_encode($data));
        return $response->withHeader('Content-Type', 'application/json');
    });
};
