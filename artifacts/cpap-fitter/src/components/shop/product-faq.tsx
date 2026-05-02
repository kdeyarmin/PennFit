// ProductFaq — accordion of frequently asked questions on every
// product detail page. Two-tier content model:
//
//   1. UNIVERSAL Q&As that apply to every SKU (shipping window,
//      insurance/HSA-FSA, returns, prescription requirements).
//      These are the questions a first-time CPAP buyer reliably
//      asks before checkout — surfacing them inline reduces
//      pre-purchase support contacts and demonstrably lifts
//      add-to-cart → completed-order conversion (cf. Casper,
//      Aura, Hims merchandising playbooks).
//
//   2. CATEGORY-SPECIFIC Q&As keyed by ShopProductView.category.
//      Each category has 2-3 questions tuned to the actual
//      objection a shopper has at that decision point — e.g.
//      cushion buyers ask "how often should I replace it",
//      filter buyers ask "do I really need to replace these",
//      mask buyers ask "what if it doesn't fit". The PennPaps
//      catalog has eight categories; we keep one entry for each
//      so the accordion is meaningful no matter which PDP a
//      shopper lands on.
//
// Pure presentation: no data fetching, no mutation, no backend
// dependency. Rendered just under the Hero on shop-product-detail
// so it shows up before the cross-sell strips that follow.

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { ShopProductView } from "@/lib/shop-api";

type Category = ShopProductView["category"];

interface FaqEntry {
  q: string;
  /** Plain-text answer; rendered into a <p>. */
  a: string;
}

// Questions every shopper has, regardless of SKU. Order matters:
// shipping is the #1 pre-purchase concern, then payment/insurance,
// then post-purchase comfort (returns), then prescription friction.
const UNIVERSAL_FAQS: FaqEntry[] = [
  {
    q: "When will my order ship?",
    a: "In-stock items ship the same business day if ordered by 2 PM ET, otherwise the next business day. Standard delivery lands in 2–5 business days; tracking is emailed as soon as the label prints.",
  },
  {
    q: "Do you bill insurance, HSA, or FSA?",
    a: "We bill most major insurance plans for resupply orders — visit How insurance works to enroll. For one-off shop purchases, HSA and FSA cards are accepted at checkout the same as any other card.",
  },
  {
    q: "What's your return policy?",
    a: "Unopened, unused supplies can be returned within 30 days for a full refund. Mask cushions and full masks are covered by our 30-day fit guarantee — if it doesn't fit comfortably, we'll exchange it free.",
  },
  {
    q: "Do I need a prescription?",
    a: "Masks, machines, and humidifier chambers are FDA-classified prescription devices and require a current Rx on file. Cushions, filters, tubing, headgear, and accessories ship without a prescription. We can request the Rx from your sleep doctor if you don't have a copy handy.",
  },
];

// Per-category Q&As. Every category in ShopProductView gets an
// entry — there is no "fallback" so we never silently render an
// incomplete FAQ if a new category is added in the future. The
// `satisfies` constraint at the bottom enforces this at type
// check time.
const CATEGORY_FAQS = {
  mask: [
    {
      q: "What if the mask doesn't fit comfortably?",
      a: "Our 30-day fit guarantee covers it — exchange it for a different size or style at no charge. Run the Virtual Mask Fitter first if you want a sizing recommendation before you order.",
    },
    {
      q: "How often should I replace a full mask?",
      a: "Insurance typically allows a full new mask every 3 months. Even if you're paying out of pocket, swapping the cushion alone monthly and the full mask every 6 months keeps the seal reliable.",
    },
  ],
  cushion: [
    {
      q: "How often should cushions be replaced?",
      a: "Most clinicians recommend swapping the cushion every 2–4 weeks. The silicone slowly compresses and absorbs facial oils, which is the #1 cause of new leaks on a mask that used to seal fine.",
    },
    {
      q: "Will this cushion fit my mask frame?",
      a: "Cushions are frame-specific — match the model number on this page to the model printed on the inside of your current mask frame. If you're unsure, message us a photo of the frame and we'll confirm.",
    },
  ],
  filter: [
    {
      q: "Do I really need to replace filters that often?",
      a: "Yes. A clogged filter forces the blower to work harder, raises noise, and pulls dust straight into the airway. Disposable filters are a 30-day item; reusable foam filters get rinsed weekly and replaced every 6 months.",
    },
    {
      q: "Are these filters compatible with my machine?",
      a: "Filters are machine-specific. Match the model number above to the make/model printed on the bottom of your CPAP. ResMed AirSense, Philips DreamStation, and Fisher & Paykel each use a different cut.",
    },
  ],
  tubing: [
    {
      q: "How often should I replace CPAP tubing?",
      a: "Every 90 days for standard tubing, sooner if you see cracks, discoloration, or persistent moisture you can't dry out. Heated tubing has the same 90-day cadence — the heating wire degrades on the same schedule as the hose.",
    },
    {
      q: "Standard vs heated tubing — which do I need?",
      a: "If your machine has a heated humidifier and a 'climate control' setting, you want heated tubing — it eliminates rainout (water condensing in the hose). Standard tubing is fine if you don't use heated humidification.",
    },
  ],
  headgear: [
    {
      q: "Will this headgear fit my mask?",
      a: "Headgear is mask-specific. The clips and Velcro placement are tuned to one mask family — match the model number on this page to your current mask. We carry replacement headgear for every mask we sell.",
    },
    {
      q: "When should headgear be replaced?",
      a: "Every 6 months on average. Once the elastic loses tension you'll find yourself overtightening the straps to maintain a seal, which causes red marks and pressure sores. Fresh headgear fixes both at once.",
    },
  ],
  chamber: [
    {
      q: "How often do I replace the humidifier chamber?",
      a: "Every 6 months, or sooner if you see mineral buildup or cloudiness that doesn't come off with vinegar. Daily distilled water and weekly cleaning extend chamber life — tap water shortens it dramatically.",
    },
    {
      q: "Is this chamber compatible with my machine?",
      a: "Chambers are machine-specific and are not interchangeable between brands. Match the model number above to the make and model printed on the bottom of your CPAP.",
    },
  ],
  accessory: [
    {
      q: "Do accessories require a prescription?",
      a: "No. Cleaning supplies, wipes, travel cases, chinstraps, and similar accessories ship without a prescription and are eligible for HSA/FSA reimbursement.",
    },
    {
      q: "Can I add this to my resupply schedule?",
      a: "Yes — log into your account after checkout and add this item to a recurring shipment so it arrives on the same cadence as your cushions and filters.",
    },
  ],
  bundle: [
    {
      q: "What's in this bundle?",
      a: "Each bundle is pre-built to match a 30-day or 90-day insurance replacement cadence so you don't have to remember which items are due when. The exact contents are listed in the description above.",
    },
    {
      q: "Is the bundle cheaper than buying items individually?",
      a: "Bundles are priced at the sum of their components — the value is convenience and never missing a replacement, not a discount. If you want a discount, set up a recurring resupply subscription on the items.",
    },
  ],
} satisfies Record<Category, FaqEntry[]>;

interface Props {
  product: ShopProductView;
}

export function ProductFaq({ product }: Props) {
  const categoryFaqs = CATEGORY_FAQS[product.category];
  // Category-specific questions go FIRST — a shopper on a cushion
  // PDP cares more about cushion-specific concerns than about the
  // generic shipping question, which they'll have seen on every
  // PDP they visited. Universals act as the long tail.
  const all = [...categoryFaqs, ...UNIVERSAL_FAQS];

  return (
    <section
      className="mt-12 md:mt-16"
      aria-labelledby="pdp-faq-heading"
      data-testid="pdp-faq"
    >
      <div className="mb-5">
        <h2
          id="pdp-faq-heading"
          className="text-xl md:text-2xl font-bold tracking-tight text-[hsl(var(--penn-navy))]"
        >
          Frequently asked
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Quick answers to the questions shoppers ask most before they buy.
        </p>
      </div>
      <Accordion
        type="single"
        collapsible
        className="rounded-xl border border-border/60 bg-white/60 backdrop-blur-sm px-4 md:px-5"
      >
        {all.map((entry, i) => (
          <AccordionItem
            key={entry.q}
            value={`faq-${i}`}
            className="last:border-b-0"
            data-testid={`pdp-faq-item-${i}`}
          >
            <AccordionTrigger className="text-base font-semibold text-foreground hover:no-underline">
              {entry.q}
            </AccordionTrigger>
            <AccordionContent>
              <p className="text-sm text-foreground/80 leading-relaxed">
                {entry.a}
              </p>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
