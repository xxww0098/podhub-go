import { ArrowDown, ArrowRight, LockKeyhole } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Shell } from "./public-site-shell"

const stages = [
  ["选品", "从平台维护的商品目录中挑选商品，按类目填写所需字段。"],
  ["导图", "导入设计图片，在浏览器内合成商品图，先预览再提交。"],
  ["提交", "检查字段和素材后提交，再核对平台处理结果。不确定的状态会明确标记。"],
] as const

const products = [
  ["/site/product-shirt.jpg", "T 恤"],
  ["/site/product-tote.jpg", "帆布包"],
  ["/site/product-mug.jpg", "马克杯"],
] as const

export function PublicSite() {
  return (
    <Shell>
      <section className="wrap product-hero" aria-labelledby="product-title">
        <div className="hero-copy">
          <h1 id="product-title">把设计稿做成能上架的商品</h1>
          <p>
            为 Ozon 按需印刷准备商品。<br />
            选品、导图、检查信息，再提交并核对平台处理结果。
          </p>
          <div className="hero-actions">
            <a className={`${buttonVariants({ size: "lg" })} site-primary`} href="/login">
              登录工作台<ArrowRight aria-hidden />
            </a>
            <a className="site-text-link" href="#workflow">
              了解使用流程<ArrowDown aria-hidden />
            </a>
          </div>
          <p className="hero-note"><LockKeyhole aria-hidden />店铺凭证不落在浏览器</p>
        </div>
        <img
          className="hero-photo"
          src="/site/hero-tote.jpg"
          alt="印有植物图案的帆布包商品效果"
          width={1672}
          height={941}
          fetchPriority="high"
        />
      </section>

      <section className="wrap product-showcase" id="products" aria-labelledby="showcase-title">
        <div className="section-heading">
          <h2 id="showcase-title">让设计落在商品上。</h2>
          <p>商品效果示例</p>
        </div>
        <div className="product-grid">
          {products.map(([src, name]) => (
            <figure key={name}>
              <div className="shot">
                <img src={src} alt={`${name}商品效果示例`} width={1254} height={1254} loading="lazy" />
              </div>
              <figcaption>{name}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-title">
        <div className="wrap workflow-inner">
          <div className="workflow-heading">
            <h2 id="workflow-title">从选品到提交，<br />分步完成。</h2>
            <p>预览不会改动店铺。<br />提交后核对平台处理结果。</p>
          </div>
          <ol className="workflow-steps">
            {stages.map(([name, body], index) => (
              <li key={name}>
                <span className="step-number" aria-hidden>0{index + 1}</span>
                <h3>{name}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="wrap site-cta" aria-labelledby="cta-title">
        <h2 id="cta-title">从你的第一件商品开始。</h2>
        <a className={`${buttonVariants({ size: "lg" })} site-primary`} href="/login">
          登录工作台<ArrowRight aria-hidden />
        </a>
      </section>
    </Shell>
  )
}
