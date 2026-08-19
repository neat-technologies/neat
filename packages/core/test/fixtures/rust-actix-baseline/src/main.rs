use actix_web::{get, post, route, web, App, HttpResponse, HttpServer};

// A derive macro must never be read as a route — it names no path.
#[derive(serde::Deserialize)]
struct QuoteRequest {
    address: String,
}

#[derive(serde::Deserialize)]
struct ShipRequest {
    items: u32,
}

// Attribute-macro routes — the macro name is the HTTP method, the string is the path.
#[post("/get-quote")]
async fn get_quote(_req: web::Json<QuoteRequest>) -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[post("/ship-order")]
async fn ship_order(_req: web::Json<ShipRequest>) -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[get("/health")]
async fn health() -> HttpResponse {
    HttpResponse::Ok().finish()
}

// The multi-method attribute macro fans out to one route per method.
#[route("/status", method = "GET", method = "HEAD")]
async fn status() -> HttpResponse {
    HttpResponse::Ok().finish()
}

// A builder-registered handler; the method comes from the `web::<verb>()` call.
async fn legacy_quote() -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .service(get_quote)
            .service(ship_order)
            .service(health)
            .service(status)
            .route("/legacy-quote", web::post().to(legacy_quote))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}
