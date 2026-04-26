import React, { useState } from "react";
import { useListMasks, MaskEntryType } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Filter } from "lucide-react";

export function Masks() {
  const { data, isLoading } = useListMasks();
  const [filter, setFilter] = useState<MaskEntryType | "all">("all");

  const filteredMasks = data?.masks.filter((m) => filter === "all" || m.type === filter) || [];

  return (
    <div className="container max-w-6xl mx-auto px-4 py-12">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-10 gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Mask Catalog</h1>
          <p className="text-muted-foreground">Browse all available CPAP masks.</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 mr-2 text-sm font-medium text-muted-foreground">
            <Filter className="w-4 h-4" /> Filter:
          </div>
          <Button 
            variant={filter === "all" ? "default" : "outline"} 
            size="sm" 
            onClick={() => setFilter("all")}
          >
            All
          </Button>
          <Button 
            variant={filter === "fullFace" ? "default" : "outline"} 
            size="sm" 
            onClick={() => setFilter("fullFace")}
          >
            Full Face
          </Button>
          <Button 
            variant={filter === "nasal" ? "default" : "outline"} 
            size="sm" 
            onClick={() => setFilter("nasal")}
          >
            Nasal
          </Button>
          <Button 
            variant={filter === "nasalPillow" ? "default" : "outline"} 
            size="sm" 
            onClick={() => setFilter("nasalPillow")}
          >
            Nasal Pillow
          </Button>
          <Button 
            variant={filter === "hybrid" ? "default" : "outline"} 
            size="sm" 
            onClick={() => setFilter("hybrid")}
          >
            Hybrid
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Skeleton key={i} className="h-[300px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredMasks.map((mask) => (
            <Card key={mask.id} className="flex flex-col hover:shadow-md transition-shadow">
              <div className="aspect-[4/3] w-full bg-muted/30 border-b border-border flex items-center justify-center p-6 relative">
                <Badge className="absolute top-4 left-4" variant="secondary">
                  {mask.manufacturer}
                </Badge>
                <div className="text-center text-muted-foreground text-sm">
                  Image Placeholder<br/>{mask.name}
                </div>
              </div>
              <CardHeader>
                <CardTitle className="text-lg">{mask.name}</CardTitle>
                <div className="text-sm text-muted-foreground capitalize">
                  {mask.type.replace(/([A-Z])/g, ' $1').trim()} Mask
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="space-y-3">
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Features</h4>
                    <ul className="text-sm space-y-1">
                      {mask.features.slice(0, 3).map((f, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <div className="w-1 h-1 rounded-full bg-primary/60 mt-2 shrink-0" />
                          <span className="line-clamp-1">{f}</span>
                        </li>
                      ))}
                      {mask.features.length > 3 && (
                        <li className="text-xs text-muted-foreground pl-2.5">+ {mask.features.length - 3} more</li>
                      )}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
