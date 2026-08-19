# Precision guard: this file names no Sinatra route surface (it neither requires
# sinatra nor subclasses Sinatra::Base), so the recognizer reads nothing here —
# even though it carries a bare `post` word and a receiver'd `get`.
class Mailer
  def deliver(client, payload)
    client.post('/smtp/send')
    get_transport.deliver(payload)
  end

  def get_transport
    @transport
  end
end
