import { Check } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import type { PageKey } from "@/lib/public-pages"
import { Catalog } from "./public-site-catalog"
import { Product } from "./public-site-home"
import { CTA, Intro, Shell } from "./public-site-shell"

const plans = [
  ["个人", "一个人打磨自己的目录", "Cloud Draft 与 Runs", "核心类目模块"],
  ["工作室", "小工作空间共用上架标准", "工作空间权益", "共享目录配方"],
  ["运营", "大批量、有铺开需求的工作空间", "托管店铺位", "迁移支持"],
]

function Pricing({ signedIn }: { signedIn: boolean }) {
  return (
    <Shell page="pricing" signedIn={signedIn}>
      <Intro
        title="围绕目录运营设计的套餐。"
        body="登录后开放商业访问。这些页面不做结账。"
      />
      <section className="wrap plans" aria-label="规划的套餐">
        {plans.map(([name, audience, first, second], index) => (
          <article key={name} className={index === 2 ? "featured" : undefined}>
            <div>
              <h2>{name}</h2>
              <p>{audience}</p>
            </div>
            <strong>{index === 2 ? "联系我们规划上线" : "发布前公布价格"}</strong>
            <ul>
              {[first, second, "同源 Cloud API"].map((benefit) => (
                <li key={benefit}><Check aria-hidden />{benefit}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>
      <section className="wrap local-grid">
        <h2>每个套餐都保存在 Cloud</h2>
        <div>
          {["Listing 卡片与 Draft", "Runs 与 Receipt", "加密的 Seller 凭证", "最终提交"].map(
            (item) => <p key={item}><Check aria-hidden />{item}</p>,
          )}
        </div>
      </section>
      <section className="c-pricing-scene">
        <img src="/site/hero-tote.jpg" alt="" loading="lazy" />
        <div className="wrap">
          <h2>从设计稿到线上商品。</h2>
          <p>告诉我们你的目录与工作空间情况，一起规划适合的上架方式。</p>
          <a href="mailto:sales@ozon-pod.app">联系销售 →</a>
        </div>
      </section>
      <CTA
        title="需要迁移方案？"
        body="告诉我们你的目录与工作空间情况。"
        label="联系销售"
        href="mailto:sales@ozon-pod.app"
      />
    </Shell>
  )
}

const faqs = [
  ["在哪里登录？", "使用右上角的「登录」。工作台与这些页面同一源。"],
  ["Draft 存在哪里？", "Draft、Runs 与操作历史保存在你工作空间的 Cloud PostgreSQL。"],
  ["为什么提交会显示 Result Unknown？", "Cloud 无法证明 Ozon 是否接受了请求。不要重复提交，改用 Reconciliation。"],
  ["这些页面能管理我的账户吗？", "不能。账户、工作空间与权益控制都在登录之后。"],
]

function Help({ signedIn }: { signedIn: boolean }) {
  return (
    <Shell page="help" signedIn={signedIn}>
      <div className="c-help-hero">
        <Intro
          title="上架工作的常见问题。"
          body="公开帮助无需登录即可查看。登录后继续获得账户专属支持。"
        />
        <img src="/site/product-mug.jpg" alt="" loading="lazy" />
      </div>
      <section className="wrap help">
        <aside>
          <h2>联系支持</h2>
          <p>附上最小的可复现描述和稳定的错误码。</p>
          <a className={`${buttonVariants({ size: "lg" })} nav-login`} href="mailto:support@ozon-pod.app">
            邮件支持
          </a>
          <strong>请勿发送</strong>
          <span>Seller API 凭证</span>
          <span>客户或订单数据</span>
        </aside>
        <div>
          {faqs.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="wrap routes">
        {[
          ["/privacy/", "了解数据处理方式", "公开隐私声明"],
          ["/terms/", "查看产品条款", "使用与发布条件"],
        ].map(([href, title, text]) => (
          <a href={href} key={href}>
            <strong>{title}</strong>
            <span>{text}</span>
          </a>
        ))}
      </section>
    </Shell>
  )
}

const privacy = [
  ["范围", "本声明覆盖与登录后应用同一源的 PodHub 公开页面。Seller API 执行与 Cloud Draft 都在登录之后。"],
  ["公开页面数据", "托管服务商可能处理标准请求数据，如 IP 地址、用户代理、路径、时间戳与安全日志。本版本不含广告跟踪器。"],
  ["应用数据", "登录后的应用把 Draft、Runs 与操作历史保存在 Cloud。Seller 凭证静态加密存储。"],
  ["支持消息", "支持工作空间只处理回答你所需的消息。普通邮件不要包含凭证、客户数据或源稿。"],
  ["保留与权利", "安全日志与支持记录只在必要时保留。隐私请求请发邮件至 privacy@ozon-pod.app。"],
]

const terms = [
  ["产品边界", "登录后的应用负责准备 Listing 与经过批准的 Ozon 操作。这些页面提供公开的产品、帮助与法律信息。"],
  ["账户与凭证", "保管好你的凭证。PodHub 不会通过这些页面或普通邮件索要明文 Seller API 凭证。"],
  ["平台操作", "审阅每个 Execution Plan。如果应用报告 Result Unknown，不要重复操作。使用 Reconciliation 或联系支持。"],
  ["可用性与变更", "公开页面的可用性不保证登录后的应用、Cloud、Ozon 或网络的可用性。更新后的条款自声明生效日起适用。"],
]

function Legal({
  page,
  signedIn,
  title,
  intro,
  sections,
  email,
}: {
  page: "privacy" | "terms"
  signedIn: boolean
  title: string
  intro: string
  sections: string[][]
  email: string
}) {
  return (
    <Shell page={page} signedIn={signedIn}>
      <section className="wrap legal-intro">
        <span>2026 年 8 月 2 日起生效</span>
        <h1>{title}</h1>
        <p>{intro}</p>
      </section>
      <section className="wrap legal">
        <nav aria-label={`${title}导航`}>
          {sections.map(([heading]) => (
            <a href={`#${heading.toLowerCase().replaceAll(" ", "-")}`} key={heading}>
              {heading}
            </a>
          ))}
        </nav>
        <article>
          {sections.map(([heading, body]) => (
            <section id={heading.toLowerCase().replaceAll(" ", "-")} key={heading}>
              <h2>{heading}</h2>
              <p>{body}</p>
            </section>
          ))}
          <div className="legal-contact">
            <strong>有问题？</strong>
            <a href={`mailto:${email}`}>{email}</a>
          </div>
        </article>
      </section>
    </Shell>
  )
}

/**
 * One page of the public site. The address is resolved once by the shell
 * ([app-route](../lib/app-route.ts)); this component paints the page it is
 * handed and never re-reads `window.location`.
 */
export function PublicSite({
  page,
  signedIn = false,
}: {
  page: PageKey
  signedIn?: boolean
}) {
  if (page === "catalog") return <Catalog signedIn={signedIn} />
  if (page === "pricing") return <Pricing signedIn={signedIn} />
  if (page === "help") return <Help signedIn={signedIn} />
  if (page === "privacy")
    return (
      <Legal
        page="privacy"
        signedIn={signedIn}
        title="隐私声明"
        intro="公开页面会处理什么、什么留在登录后的应用，以及如何联系我们。"
        sections={privacy}
        email="privacy@ozon-pod.app"
      />
    )
  if (page === "terms")
    return (
      <Legal
        page="terms"
        signedIn={signedIn}
        title="使用条款"
        intro="公开页面与登录后应用的使用条件。"
        sections={terms}
        email="legal@ozon-pod.app"
      />
    )
  return <Product signedIn={signedIn} />
}
