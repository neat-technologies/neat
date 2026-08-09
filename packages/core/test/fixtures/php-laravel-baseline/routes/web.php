<?php

use App\Http\Controllers\OrderController;
use App\Http\Controllers\PhotoController;
use Illuminate\Support\Facades\Route;

Route::get('/', 'HomeController@index');

// Explicit verbs, a literal path with a {id} param.
Route::get('/orders/{id}', [OrderController::class, 'show']);
Route::post('/orders', [OrderController::class, 'store']);
Route::put('/orders/{id}', [OrderController::class, 'update']);
Route::patch('/orders/{id}', [OrderController::class, 'sync']);
Route::delete('/orders/{id}', [OrderController::class, 'destroy']);

// An optional param and a ->where() constraint chained after the verb — neither
// changes the template.
Route::get('/users/{id?}', 'UserController@show')->where('id', '[0-9]+')->name('users.show');

// Resourceful expansion — seven rows, update on both PUT and PATCH.
Route::resource('photos', PhotoController::class);

// Nested groups: a prefix + name group with a nested prefix group inside it.
Route::prefix('admin')->name('admin.')->group(function () {
    Route::get('/dashboard', 'AdminController@dashboard');

    Route::prefix('reports')->group(function () {
        Route::get('/monthly', 'ReportController@monthly');
    });
});

// A controller group (no path contribution) whose body is an arrow-fn.
Route::controller(OrderController::class)->group(fn () => Route::get('/health', 'health'));

// A nested resource name composes into a nested path, best-effort.
Route::resource('photos.comments', 'CommentController');
