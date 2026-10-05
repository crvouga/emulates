import { describe, expect, test } from "bun:test"
import { stripeJs } from "./src/stripe-js.js"

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Array<() => void>>()
  name = ""
  parentNode: FakeElement | null = null
  placeholder = ""
  textContent = ""
  value = ""

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  appendChild(child: FakeElement) {
    child.parentNode = this
    this.children.push(child)
  }

  removeChild(child: FakeElement) {
    this.children.splice(this.children.indexOf(child), 1)
    child.parentNode = null
  }

  addEventListener(name: string, listener: () => void) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  focus() {}

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement) => {
      const name = selector.match(/^\[name="(.+)"\]$/)?.[1]
      if (name) return element.name === name
      const testId = selector.match(/^\[data-testid="(.+)"\]$/)?.[1]
      if (testId) return element.attributes.get("data-testid") === testId
      return element.tagName === selector
    }
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
}

const loadStripeJs = () => {
  const hosts = new Map<string, FakeElement>()
  const document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    querySelector: (selector: string) => hosts.get(selector) ?? null,
  }
  const window = {} as Record<string, unknown>
  new Function("window", "document", stripeJs("http://stripe.test"))(window, document)
  return {
    host(selector: string) {
      const host = new FakeElement("div")
      hosts.set(selector, host)
      return host
    },
    Stripe: window.Stripe as (key: string) => {
      elements: () => {
        create: (
          type: string,
          options?: Record<string, unknown>,
        ) => {
          mount: (selector: string) => void
          card: () => { number: string; exp_month: number; exp_year: number; cvc: string }
        }
      }
    },
  }
}

describe("Stripe.js card Elements", () => {
  test("split Elements render one unlabeled semantic control each", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()

    for (const [type, name, testId] of [
      ["cardNumber", "card", "stripe-mock-card"],
      ["cardExpiry", "exp", "stripe-mock-exp"],
      ["cardCvc", "cvc", "stripe-mock-cvc"],
    ] as const) {
      const selector = `#${type}`
      const host = browser.host(selector)
      elements.create(type).mount(selector)

      expect(host.querySelectorAll("input")).toHaveLength(1)
      expect(host.querySelector(`[name="${name}"]`)).not.toBeNull()
      expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull()
      expect(host.querySelectorAll("label")).toHaveLength(0)
    }
  })

  test("the combined card Element renders card details once and honors hidePostalCode", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const shown = browser.host("#shown")
    const hidden = browser.host("#hidden")

    elements.create("card").mount("#shown")
    elements.create("card", { hidePostalCode: true }).mount("#hidden")

    expect(shown.querySelectorAll("input").map((input) => input.name)).toEqual([
      "card",
      "exp",
      "cvc",
      "zip",
    ])
    expect(hidden.querySelectorAll("input").map((input) => input.name)).toEqual([
      "card",
      "exp",
      "cvc",
    ])
  })

  test("the cardNumber Element tokenizes values from sibling split Elements", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const numberHost = browser.host("#number")
    const expiryHost = browser.host("#expiry")
    const cvcHost = browser.host("#cvc")
    const number = elements.create("cardNumber")
    number.mount("#number")
    elements.create("cardExpiry").mount("#expiry")
    elements.create("cardCvc").mount("#cvc")

    const numberInput = numberHost.querySelector('[name="card"]')
    const expiryInput = expiryHost.querySelector('[name="exp"]')
    const cvcInput = cvcHost.querySelector('[name="cvc"]')
    if (!numberInput || !expiryInput || !cvcInput) throw new Error("split inputs did not mount")
    numberInput.value = "4242 4242 4242 4242"
    expiryInput.value = "09/35"
    cvcInput.value = "987"

    expect(number.card()).toEqual({
      number: "4242424242424242",
      exp_month: 9,
      exp_year: 2035,
      cvc: "987",
    })
  })
})
