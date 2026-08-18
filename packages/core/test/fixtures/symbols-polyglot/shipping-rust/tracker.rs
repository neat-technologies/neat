// Shipment tracker — second Rust fixture file, file-scope types (#1038).

struct Tracker {
    shipped: u32,
}

impl Tracker {
    fn new() -> Tracker {
        Tracker { shipped: 0 }
    }

    fn record(&mut self) -> u32 {
        self.shipped += 1;
        self.shipped
    }
}

fn record_shipment() -> u32 {
    let mut t = Tracker::new();
    t.record()
}
