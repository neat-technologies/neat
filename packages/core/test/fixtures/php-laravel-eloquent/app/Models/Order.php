<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

// The Eloquent model maps `Order` → the pluralized snake_case table `orders`
// (ADR-178). The migration literal is the anchor; the model adds the class↔table
// link and the belongsTo relation edge.
class Order extends Model
{
    public function user()
    {
        return $this->belongsTo(User::class);
    }
}
