require 'sinatra'
require 'json'

post '/send_order_confirmation' do
  data = JSON.parse(request.body.read)
  # A receiver'd verb call inside a route body is not the DSL — it must not mint.
  logger.post('/audit') if settings.development?
  status 200
  'sent'
end

get '/health' do
  'ok'
end

get '/orders/:id' do
  params['id']
end
