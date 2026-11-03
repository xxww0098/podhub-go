import { useEffect, type ReactNode } from "react"
import { buttonVariants } from "@/components/ui/button"

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
  return (
    <a className="brand" href="/" aria-label="PodHub 首页">
      <BrandMark />
      <strong>PodHub</strong>
    </a>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.title = "PodHub | 浏览器 Ozon 上架工作室"
  }, [])

  return (
    <div className="public-site">
      <a className="skip" href="#main-content">跳到主要内容</a>
      <header className="header">
        <div className="wrap header-in">
          <Brand />
          <nav aria-label="产品页导航">
            <a href="#products">产品展示</a>
            <a href="#workflow">使用流程</a>
          </nav>
          <div className="header-actions">
            {/* 已登录卖家也经此入口进入工厂面，再按成员身份分诊。 */}
            <a className={`${buttonVariants({ variant: "outline", size: "sm" })} site-secondary`} href="/supplier">
              工厂登录
            </a>
            <a className={`${buttonVariants({ size: "sm" })} site-primary`} href="/login">
              登录
            </a>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="site-footer">
        <div className="wrap footer-inner">
          <Brand />
          <span>© 2026 PodHub</span>
          <a href="mailto:support@ozon-pod.app">邮件支持</a>
        </div>
      </footer>
    </div>
  )
}
