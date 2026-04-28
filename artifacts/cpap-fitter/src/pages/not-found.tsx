import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Compass, Home as HomeIcon } from "lucide-react";

export default function NotFound() {
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
            The page you're looking for doesn't exist on the PennPaps site. Let's get you back on track.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-3 justify-center pt-4 pb-8">
          <Link href="/">
            <Button className="w-full sm:w-auto btn-primary-glow rounded-full px-6">
              <HomeIcon className="w-4 h-4 mr-2" />
              Return to PennPaps Home
            </Button>
          </Link>
          <Link href="/masks">
            <Button variant="outline" className="w-full sm:w-auto rounded-full glass-panel border-0 px-6">
              Browse Mask Catalog
            </Button>
          </Link>
        </CardContent>
      </Card>
      <p className="text-center text-xs text-muted-foreground mt-6">
        Need help? Contact PennPaps for personalized fitting assistance.
      </p>
    </div>
  );
}
