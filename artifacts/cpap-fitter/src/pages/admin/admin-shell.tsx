import { useQuery } from "@tanstack/react-query";
import { Link, Redirect, useLocation } from "wouter";
import { fetchAdminMe, AdminApiError } from "@/lib/admin-api";
import { AdminLayout } from "@/components/admin-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldOff } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { SignedIn, SignedOut, useShopIdentity } from "@/lib/identity";

/**
 * AdminShell — wraps an admin page with two layered checks:
 *
 *   1. Signed-out users get redirected to /sign-in (via the
 *      identity shim's <SignedOut>).
 *      We deliberately do NOT redirect from "/" — only from /admin*.
 *