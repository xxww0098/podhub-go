import { Cloud, Layers, ScanSearch, Waypoints } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { CTA, Shell } from "./public-site-shell"

const proof = [
  [Cloud, "同一网站", "介绍页和工作台同一个地址"],
  [Layers, "按类目填写", "只出现这个类目需要的字段"],
  [Waypoints, "本机出图", "设计稿在线合成商品图"],
  [ScanSearch, "结果可核对", "不确定的提交会标明，不假装成功"],
] as const

const stages = [
  ["01", "选品", "在平台维护的商品目录里，挑出要做的商品。"],
  ["02", "导图", "导入设计图片，在线合成商品图。"],
  ["03", "上架", "预览确认后写入店铺，结果可核对。"],
]

const featuredProducts = [
  ["/site/product-shirt.jpg", "T 恤"],
  ["/site/product-tote.jpg", "帆布包"],
  ["/site/product-mug.jpg", "马克杯"],
] as const

export function Product({ signedIn }: { signedIn: boolean }) {
  const accessHref = signedIn ? "/" : "/login"
  const accessLabel = signedIn ? "进入工作台" : "登录"

  return (
    <Shell page="product" signedIn={signedIn}>
      <section className="c-hero">
        <img
          className="c-hero-photo"
          src="/site/hero-tote.jpg"
          alt="印有植物图案的帆布包商品效果"
          fetchPriority="high"
        />
        <div className="wrap c-hero-inner">
          <div className="c-hero-copy">
            <span className="c-eyebrow">OZON 按需印刷上架工作室</span>
            <h1>把设计稿做成能上架的商品</h1>
            <p>
              在商品目录选好品，导入图片，上架到 Ozon 店铺。就这三步，不用另装软件。
            </p>
            <div className="c-hero-actions">
              <a className={`${buttonVariants({ size: "lg" })} c-primary-link`} href={accessHref}>
                {accessLabel}
              </a>
              <a className={`${buttonVariants({ variant: "outline", size: "lg" })} c-secondary-link`} href="/catalog/">
                浏览商品目录
              </a>
            </div>
            <ul className="c-hero-notes">
              <li>店铺凭证不落在浏览器</li>
              <li>提交即写入线上店铺</li>
            </ul>
          </div>
          <div className="c-hero-visual">
            <div className="c-design-chip">
              <span>设计稿</span>
              <strong>从图片开始</strong>
            </div>
            <div className="c-listing-chip">
              <span>上架预览</span>
              <strong>确认商品信息，再提交</strong>
              <small>设计稿检查完成后即可上架</small>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap c-process">
        <div className="c-process-head">
          <span className="c-eyebrow">从选品到提交</span>
          <h2>上架，就这三步。</h2>
          <p>从商品目录到线上店铺，每一步都有结果。预览不会改动店铺。</p>
        </div>
        <ol className="c-steps">
          {stages.map(([index, name, body]) => (
            <li key={name}>
              <em>{index}</em>
              <strong>{name}</strong>
              <span>{body}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="c-catalog-preview">
        <div className="wrap">
          <div className="c-section-heading">
            <div>
              <span className="c-eyebrow">商品目录</span>
              <h2>先选商品，再做设计。</h2>
            </div>
            <a href="/catalog/">浏览商品目录 →</a>
          </div>
          <div className="c-product-grid">
            {featuredProducts.map(([src, name]) => (
              <a href="/catalog/" key={name}>
                <img src={src} alt={name} loading="lazy" />
                <strong>{name}</strong>
                <span>查看商品目录 →</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="wrap c-capabilities">
        <div className="c-section-heading">
          <div>
            <span className="c-eyebrow">完整工作流程</span>
            <h2>上架要做的事，都在这一处。</h2>
          </div>
        </div>
        <div className="c-capability-grid">
          {proof.map(([Icon, title, body]) => (
            <article key={title}>
              <Icon aria-hidden />
              <strong>{title}</strong>
              <p>{body}</p>
            </article>
          ))}
          <article>
            <strong>先预览再提交</strong>
            <p>看清将对店铺做什么，再动手。</p>
          </article>
        </div>
      </section>

      <CTA
        title="登录，开始上架"
        body="公开页不结账、不开店。登录后进入上架工作台。"
        label={accessLabel}
        href={accessHref}
      />
    </Shell>
  )
}

