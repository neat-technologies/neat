Rails.application.routes.draw do
  root to: 'pages#main'

  get '/about', to: 'pages#about'
  post 'contact' => 'pages#contact'
  get 'status'

  resources :orders do
    member do
      get :preview
    end
    collection do
      get :search
    end
  end

  resource :profile

  namespace :admin do
    resources :articles
  end

  scope '/legacy' do
    resources :widgets, only: [:index, :show]
  end

  scope module: 'internal' do
    resources :metrics, except: :destroy
  end

  scope path: '/v2', module: 'v2' do
    resources :gadgets, only: [:index]
  end

  resources :magazines do
    resources :ads
  end

  # Deferred: a mounted engine surfaces as observed-only divergence, not a route.
  mount Sidekiq::Web => '/sidekiq'
end
