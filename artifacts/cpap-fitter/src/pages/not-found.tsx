import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Compass, Home as HomeIcon } from "lucide-react";

export default function NotFound() {
  return (
    <div className="container max-w-2xl mx-auto px-4 py-16 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card className="border-border shadow-sm">
        <CardHeader className="space-y-4 text-center">
          <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mx-auto">
            <Compass className="w-8 h-8" />
          </div>
          <CardTitle className="text-3xl">Page Not Found</CardTitle>
          <CardDescription className="text-base max-w-md mx-auto">
            The page you're looking for doesn't exist on the Penn Fit site. Let's get you back on track.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-3 justify-center pt-2 pb-8">
          <Link href="/">
            <Button className="w-full sm:w-auto">
              <HomeIcon className="w-4 h-4 mr-2" />
              Return to Penn Fit Home
            </Button>
          </Link>
          <Link href="/masks">
            <Button variant="outline" className="w-full sm:w-auto">
              Browse Mask Catalog
            </Button>
          </Link>
        </CardContent>
      </Card>
      <p className="text-center text-xs text-muted-foreground mt-6">
        Need help? Contact Penn Home Medical Supply for personalized fitting assistance.
      </p>
    </div>
  );
}
