'use client'

import { useEffect, useRef } from 'react'

const LETTERS = ['N', 'E', 'A', 'T'] as const
const HOLD_MS = 900
const FLIP_MS = 140

export function LogoAnimation() {
  const letterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = letterRef.current
    if (!el) return

    let current = 0
    let cancelled = false
    let timers: number[] = []

    function schedule(fn: () => void, delay: number): void {
      const id = window.setTimeout(() => {
        timers = timers.filter((t) => t !== id)
        if (!cancelled) fn()
      }, delay)
      timers.push(id)
    }

    function tick(): void {
      if (!el) return
      el.classList.remove('flip-in')
      el.classList.add('flip-out')
      schedule(() => {
        current = (current + 1) % LETTERS.length
        el.textContent = LETTERS[current]
        el.classList.remove('flip-out')
        el.classList.add('flip-in')
        schedule(() => {
          el.classList.remove('flip-in')
          schedule(tick, HOLD_MS)
        }, FLIP_MS)
      }, FLIP_MS)
    }

    schedule(tick, HOLD_MS)
    return () => {
      cancelled = true
      timers.forEach((id) => window.clearTimeout(id))
    }
  }, [])

  return (
    <div className="logo-stage" aria-hidden="true">
      <div className="logo-diamond-outer">
        <svg viewBox="0 0 220 220" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polygon points="110,4 216,110 110,216 4,110" stroke="white" strokeWidth="1" fill="none" opacity="0.9" />
          <line x1="110" y1="4" x2="110" y2="18" stroke="white" strokeWidth="2" opacity="0.6" />
          <line x1="216" y1="110" x2="202" y2="110" stroke="white" strokeWidth="2" opacity="0.6" />
          <line x1="110" y1="216" x2="110" y2="202" stroke="white" strokeWidth="2" opacity="0.6" />
          <line x1="4" y1="110" x2="18" y2="110" stroke="white" strokeWidth="2" opacity="0.6" />
          <rect x="107" y="1" width="6" height="6" fill="white" transform="rotate(45 110 4)" opacity="1" />
          <rect x="213" y="107" width="6" height="6" fill="white" transform="rotate(45 216 110)" opacity="1" />
          <rect x="107" y="213" width="6" height="6" fill="white" transform="rotate(45 110 216)" opacity="1" />
          <rect x="1" y="107" width="6" height="6" fill="white" transform="rotate(45 4 110)" opacity="1" />
        </svg>
      </div>

      <div className="logo-diamond-inner">
        <svg viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polygon points="90,6 174,90 90,174 6,90" stroke="white" strokeWidth="0.5" fill="none" opacity="0.3" />
          <line x1="90" y1="6" x2="90" y2="14" stroke="white" strokeWidth="1" opacity="0.3" />
          <line x1="174" y1="90" x2="166" y2="90" stroke="white" strokeWidth="1" opacity="0.3" />
          <line x1="90" y1="174" x2="90" y2="166" stroke="white" strokeWidth="1" opacity="0.3" />
          <line x1="6" y1="90" x2="14" y2="90" stroke="white" strokeWidth="1" opacity="0.3" />
        </svg>
      </div>

      <div className="logo-scan" />

      <div className="logo-letter-stage">
        <div className="logo-letter-face" ref={letterRef} data-testid="logo-letter">N</div>
      </div>

      <span className="logo-pip logo-pip-top" />
      <span className="logo-pip logo-pip-right" />
      <span className="logo-pip logo-pip-bottom" />
      <span className="logo-pip logo-pip-left" />

      <div className="logo-label">Network Environment Architecture Tools</div>

      <style jsx>{`
        .logo-stage {
          position: relative;
          width: 260px;
          height: 260px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .logo-diamond-outer {
          position: absolute;
          inset: 0;
          animation: logo-spin 8s linear infinite;
        }
        .logo-diamond-outer svg { width: 100%; height: 100%; }

        @keyframes logo-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }

        .logo-diamond-inner {
          position: absolute;
          inset: 16px;
          animation: logo-spin-reverse 8s linear infinite;
        }
        .logo-diamond-inner svg { width: 100%; height: 100%; }

        @keyframes logo-spin-reverse {
          from { transform: rotate(0deg); }
          to   { transform: rotate(-360deg); }
        }

        .logo-letter-stage {
          position: relative;
          width: 100px;
          height: 100px;
          perspective: 500px;
          z-index: 10;
        }

        .logo-letter-face {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: 86px;
          font-weight: 300;
          color: #fff;
          letter-spacing: -0.02em;
          line-height: 1;
          backface-visibility: hidden;
          transform-style: preserve-3d;
          transform: rotateY(0deg);
        }

        .logo-letter-face.flip-out {
          animation: logo-flip-out ${FLIP_MS}ms ease-in forwards;
        }
        .logo-letter-face.flip-in {
          animation: logo-flip-in ${FLIP_MS}ms ease-out forwards;
        }

        @keyframes logo-flip-out {
          from { transform: rotateY(0deg);   opacity: 1; }
          to   { transform: rotateY(90deg);  opacity: 0.2; }
        }
        @keyframes logo-flip-in {
          from { transform: rotateY(-90deg); opacity: 0.2; }
          to   { transform: rotateY(0deg);   opacity: 1; }
        }

        .logo-pip {
          position: absolute;
          width: 6px;
          height: 6px;
          background: #fff;
          animation: logo-pip-pulse 8s linear infinite;
        }
        .logo-pip-top    { top: 2px;    left: 50%; transform: translateX(-50%) rotate(45deg); }
        .logo-pip-right  { right: 2px;  top: 50%;  transform: translateY(-50%) rotate(45deg); }
        .logo-pip-bottom { bottom: 2px; left: 50%; transform: translateX(-50%) rotate(45deg); }
        .logo-pip-left   { left: 2px;   top: 50%;  transform: translateY(-50%) rotate(45deg); }

        @keyframes logo-pip-pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.3; }
        }

        .logo-scan {
          position: absolute;
          inset: 0;
          overflow: hidden;
          z-index: 5;
          pointer-events: none;
        }
        .logo-scan::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          height: 1px;
          background: rgba(255, 255, 255, 0.08);
          animation: logo-scan-move 3s linear infinite;
        }
        @keyframes logo-scan-move {
          from { top: -1px; }
          to   { top: 100%; }
        }

        .logo-label {
          position: absolute;
          bottom: -48px;
          left: 50%;
          transform: translateX(-50%);
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: 10px;
          font-weight: 400;
          letter-spacing: 0.38em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.35);
          white-space: nowrap;
        }
      `}</style>
    </div>
  )
}
