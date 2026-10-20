import { useEffect, type ReactNode } from "react"
import { buttonVariants } from "@/components/ui/button"
import { productVersionLabel } from "@/lib/product-version"
import type { PageKey } from "@/lib/public-pages"

const PAGE_TITLES: Record<PageKey, string> = {
  product: "PodHub | 浏览器 Ozon 上架工作室",
  catalog: "商品目录 | PodHub",
  pricing: "定价 | PodHub",
  help: "帮助中心 | PodHub",
  privacy: "隐私声明 | PodHub",
  terms: "使用条款 | PodHub",
}

const nav: Array<[PageKey, string, string]> = [
  ["product", "产品", "/"],
  ["catalog", "商品目录", "/catalog/"],
  ["pricing", "定价", "/pricing/"],
  ["help", "帮助", "/help/"],
]

function BrandMark() {
  return (
    <svg aria-hidden focusable="false" viewBox="0 0 1254 1254" className="mark">
      <rect width="1254" height="1254" rx="132" fill="var(--mark-blue)" />
      <path
        fill="var(--mark-white)"
        d="M599 196H487C318 196 186 337 186 506v228c0 169 132 327 301 327h112V840h-51c-90 0-156-65-156-155V570c0-89 67-157 156-157h51V196Z"
      />
      <path
        fill="var(--mark-orange)"
        d="M653 196h107c175 0 304 137 304 306v126c0 171-102 297-263 339v61c0 18-15 33-33 33H653c-7 0-12-5-12-12V800c0-28 23-50 51-50h15c85 0 154-53 154-122v-58c0-87-69-157-154-157h-54c-7 0-12-5-12-12V208c0-7 5-12 12-12Z"
      />
      <circle cx="938" cy="429" r="42" fill="var(--mark-white)" />
    </svg>
  )
}

function Brand() {
  const version = productVersionLabel()
  return (
    <a className="brand" href="/" aria-label="PodHub home">
      <BrandMark />
      <strong>PodHub</strong>
      {version ? <span className="brand-version">{version}</span> : null}
    </a>
  )
}

export function Shell({
  page,
  signedIn,
  children,
}: {
  page: PageKey
  signedIn: boolean
  children: ReactNode
}) {
  const accessHref = signedIn ? "/" : "/login"
  const accessLabel = signedIn ? "进入工作台" : "登录"

  useEffect(() => {
    document.title = PAGE_TITLES[page]
  }, [page])

  return (
    <div className="public-site" data-page={page}>
      <a className="skip" href="#main-content">
        跳到主要内容
      </a>
      <header className="header">
        <div className="wrap header-in">
          <Brand />
          <nav aria-label="Primary">
            {nav.map(([key, label, href]) => (
              <a key={key} href={href} aria-current={page === key ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {/* 厂家登录 (ADR-0100)：厂家排单面的入口。入口恒显——
                已登录卖家也会经它分流到 `/supplier`，面内再按成员身份分诊。 */}
            <a
              className={`${buttonVariants({ variant: "outline", size: "sm" })} nav-supplier`}
              href="/supplier"
            >
              工厂登录
            </a>
            <a className={`${buttonVariants({ size: "sm" })} nav-login`} href={accessHref}>
              {accessLabel}
            </a>
          </div>
        </div>
      </header>
      <main id="main-content">{children}</main>
      <footer className="site-footer">
        <div className="wrap footer-main">
          <div>
            <Brand />
            <p>给 Ozon 按需印刷团队用的上架工作室。介绍页和工作台在同一个网站。</p>
          </div>
          <div className="footer-links">
            <div>
              <strong>产品</strong>
              <a href="/catalog/">商品目录</a>
              <a href="/pricing/">定价</a>
              <a href={accessHref}>{accessLabel}</a>
            </div>
            <div>
              <strong>支持</strong>
              <a href="/help/">帮助中心</a>
              <a href="mailto:support@ozon-pod.app">邮件支持</a>
            </div>
            <div>
              <strong>法律</strong>
              <a href="/privacy/">隐私</a>
              <a href="/terms/">条款</a>
            </div>
          </div>
        </div>
        <div className="wrap footer-base">
          <span>© 2026 PodHub</span>
          <span>登录后进入上架工作台。</span>
        </div>
      </footer>
    </div>
  )
}

export function Intro({ title, body }: { title: string; body: string }) {
  return (
    <section className="wrap intro">
      <h1>{title}</h1>
      <p>{body}</p>
    </section>
  )
}

export function CTA({
  title,
  body,
  label,
  href,
}: {
  title: string
  body: string
  label: string
  href: string
}) {
  return (
    <section className="wrap cta">
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <a className={`${buttonVariants({ size: "lg" })} nav-login`} href={href}>
        {label}
      </a>
    </section>
  )
}
