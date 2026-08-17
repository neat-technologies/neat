<?php
// Quote service — PHP symbol-grain extraction fixture (#1022).

namespace App\Quote;

function format_money($amount)
{
    return round($amount, 2);
}

class QuoteService
{
    public function __construct($repo)
    {
        $this->repo = $repo;
    }

    public function calculate($items)
    {
        // An observed DB span's code.line.number points inside this method.
        return $this->repo->save($items);
    }

    public static function default_rate()
    {
        return 1.0;
    }
}

trait Loggable
{
    public function log($m)
    {
        return $m;
    }
}

interface Priceable
{
    public function price();
}

namespace App\Other;

class Widget
{
    public function build()
    {
        return 1;
    }
}
