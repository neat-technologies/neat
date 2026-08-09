<?php

use App\Http\Controllers\Api\OrderController;
use Illuminate\Support\Facades\Route;

// Every route in api.php gets the framework's automatic `/api` prefix — it is a
// RouteServiceProvider convention, not in this source.
Route::get('/orders/{id}', [OrderController::class, 'show']);
Route::post('/orders', [OrderController::class, 'store']);

// apiResource — five rows (no create, no edit).
Route::apiResource('photos', 'Api\PhotoController');

Route::prefix('v1')->group(function () {
    Route::get('/status', 'Api\StatusController@index');
});
