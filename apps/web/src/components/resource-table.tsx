"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";
type Cell=string|number|null;
interface Column{key:string;label:string}
export function ResourceTable({endpoint,columns,empty}:{endpoint:string;columns:Column[];empty:string}){const[items,setItems]=useState<Record<string,Cell>[]>([]);const[loading,setLoading]=useState(true);useEffect(()=>{apiFetch<{items:Record<string,Cell>[]}>(endpoint).then(r=>setItems(r.items)).finally(()=>setLoading(false))},[endpoint]);return <div className="paper-panel reveal reveal-delay-1"><div className="panel-header"><h2>记录</h2><span className="status-pill">{loading?"LOADING":`${items.length} ITEMS`}</span></div>{items.length?<div className="panel-body" style={{overflowX:"auto"}}><table className="data-table"><thead><tr>{columns.map(c=><th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{items.map((item,index)=><tr key={String(item.id??index)}>{columns.map(c=><td key={c.key}>{String(item[c.key]??"—")}</td>)}</tr>)}</tbody></table></div>:<div className="empty-state"><div><div className="empty-orbit"/><p>{loading?"正在读取数据库…":empty}</p></div></div>}</div>}
