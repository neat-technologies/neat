import dynamic from 'next/dynamic'
import { Suspense } from 'react'
import { LoginForm } from '@/components/login-form'

// LogoAnimation reaches for `window.setTimeout` and is purely decorative;
// load it client-only so the static HTML stays small.
const LogoAnimation = dynamic(
  () => import('@/components/logo-animation').then((m) => m.LogoAnimation),
  { ssr: false },
)

export default function LoginPage() {
  return (
    <div className="grid min-h-svh bg-background text-foreground lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            {/* `LoginForm` reads from useSearchParams — Suspense keeps the
                client transition from blocking the static shell. */}
            <Suspense fallback={null}>
              <LoginForm />
            </Suspense>
          </div>
        </div>
      </div>
      <div className="relative hidden items-center justify-center overflow-hidden bg-black lg:flex">
        <LogoAnimation />
      </div>
    </div>
  )
}
