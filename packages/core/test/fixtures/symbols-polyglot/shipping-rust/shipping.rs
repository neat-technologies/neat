// Shipping quote logic — Rust symbol-grain extraction fixture (#1038).

mod quote {
    pub struct Quote {
        pub cost: f64,
    }

    pub trait Priced {
        fn price(&self) -> f64;
        fn is_free(&self) -> bool {
            self.price() == 0.0
        }
    }

    impl Quote {
        pub fn new(cost: f64) -> Quote {
            Quote { cost }
        }

        pub fn price(&self) -> f64 {
            // An observed DB span's code.lineno points inside this method.
            self.cost * 1.1
        }
    }

    pub enum Carrier {
        Ground,
        Air,
    }

    mod internal {
        pub fn surcharge() -> f64 {
            2.5
        }
    }
}

pub fn ship_order(items: u32) -> f64 {
    let q = quote::Quote::new(items as f64 * 1.5);
    q.price()
}
