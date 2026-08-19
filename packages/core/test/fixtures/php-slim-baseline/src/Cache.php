<?php

namespace App;

// Precision guard: a `->get()` / `->post()` on a non-Slim object must mint no
// route. This file constructs no Slim App value, so the recognizer reads nothing.
class Cache
{
    private $store;

    public function warm(): void
    {
        $this->store = new \Redis();
        $value = $this->store->get('quote:key');
        $this->store->set('quote:key', $value);
    }
}
