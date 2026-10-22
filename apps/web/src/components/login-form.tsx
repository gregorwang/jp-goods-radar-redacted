"use client";
import { useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";

// 会话过期时 apiFetch 会带上当前路径跳到登录页。白名单包含所有仍在使用的站内页面，
// 让用户重新登录后回到原处。
// 仍然只接受站内相对路径，拒绝任何外部地址。
const NEXT_PATH = /^\/(dashboard|search|watches|listings|changes|events|sources|intelligence)(\/[\w.~-]*)*$/;

function safeNext(requested: string | null): Route {
  return (requested && NEXT_PATH.test(requested) ? requested : "/dashboard") as Route;
}
export function LoginForm(){const[password,setPassword]=useState("");const[error,setError]=useState("");const[loading,setLoading]=useState(false);const router=useRouter();const params=useSearchParams();async function submit(e:React.FormEvent){e.preventDefault();setLoading(true);setError("");try{const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});const body:unknown=await r.json();if(!r.ok)throw new Error(body&&typeof body==="object"&&"error" in body&&typeof body.error==="string"?body.error:"登录失败");const requested=params.get("next");const destination=safeNext(requested);router.replace(destination);router.refresh()}catch(err){setError(err instanceof Error?err.message:"登录失败")}finally{setLoading(false)}}return <form className="login-form" onSubmit={submit}><p className="eyebrow">PRIVATE ACCESS</p><h1>进入雷达室</h1><p className="hero-copy" style={{marginTop:12,fontSize:12}}>单人自用系统。请输入管理员密码。</p><div className="field" style={{marginTop:42}}><label htmlFor="password">管理员密码</label><input id="password" className="text-input" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} maxLength={300} aria-describedby="password-hint" required/><span id="password-hint" className="field-hint">请输入当前已配置的管理员密码。</span></div>{error&&<p className="form-error">{error}</p>}<button type="submit" className="primary-button" disabled={loading} aria-busy={loading} data-loading={loading} style={{width:"100%"}}>{loading?"验证中…":"进入系统"}</button></form>}
