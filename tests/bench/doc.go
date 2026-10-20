// Package bench measures the Ozon Seller outbound client against a local
// TLS server. It is not imported by the API or the workers.
//
// The server listens on 127.0.0.1 only. Mode R is the only load-test mode
// this package accepts, and it never dials api-seller.ozon.ru.
package bench
