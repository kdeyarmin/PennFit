import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Compass,
  HelpCircle,
  Home as HomeIcon,
  ShoppingBag,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCompanyContact } from "@/lib/contact";

export default function NotFound() {
  const contact = useCompanyContact();
  useDocumentTitle(
    "Page not found",
    `We couldn't find that page on ${contact.name}. Try the home page, the shop, or the mask catalog.`,
  );
  // Recovery hints — when the visitor has any localStorage signal of
  // prior shop activity, surface direct links back to it. The page
  // they were trying to reach is gone, but their cart and saved
  // items aren't, and that's usually what brought them here.
  return (
    <div className="container max-w-2xl mx-auto px-4 py-20 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="space-y-4 text-center pb-2">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl icon-halo-navy mx-auto">
            <Compass className="w-7 h-7" />
          </div>
          <div className="inline-flex items-center justify-center gap-3 mt-2">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              404 · Off the path
            </span>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
          <CardTitle className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
            Page Not Found
          </CardTitle>
          <CardDescription className="text-base max-w-md mx-auto">
            The page you're looking for doesn't exist on {contact.name}. Try the
            home page, the supply shop, or the mask fitter.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-3 justify-center pt-4 pb-8 flex-wrap">
          <Link href="/">
            <Button className="w-full sm:w-auto btn-primary-glow rounded-full px-6">
              <HomeIcon className="w-4 h-4 mr-2" />
              Return home
            </Button>
          </Link>
          <Link href="/consent">
            <Button
              variant="outline"
              className="w-full sm:w-auto rounded-full glass-panel border-0 px-6"
            >
              Get fitted for a mask
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Always-on jump links to the most useful destinations. */}
      <div className="mt-6 grid sm:grid-cols-3 gap-2">
        <Link
          href="/shop"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-[hsl(var(--penn-navy))] py-2 rounded-md hover:bg-secondary/30 transition-colors"
          data-testid="not-found-jump-shop"
        >
          <ShoppingBag className="w-3.5 h-3.5" />
          Shop
        </Link>
        <Link
          href="/faq"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-[hsl(var(--penn-navy))] py-2 rounded-md hover:bg-secondary/30 transition-colors"
          data-testid="not-found-jump-faq"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          FAQ
        </Link>
        <Link
          href="/how-it-works"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-[hsl(var(--penn-navy))] py-2 rounded-md hover:bg-secondary/30 transition-colors"
          data-testid="not-found-jump-how"
        >
          <Compass className="w-3.5 h-3.5" />
          How it works
        </Link>
      </div>

      <p className="text-center text-xs text-muted-foreground mt-6">
        Need help? Contact {contact.name} for help with mask fittings, supply
        orders, insurance, or resupply.
      </p>
    </div>
  );
}
