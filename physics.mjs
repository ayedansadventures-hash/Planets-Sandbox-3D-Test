export const G=39.47841760435743;
export function step(bodies,dt){
 const forces=()=>bodies.map(a=>{const f=[0,0,0];for(const b of bodies){if(a===b)continue;const d=b.p.map((v,i)=>v-a.p[i]);const r2=Math.max(d.reduce((s,v)=>s+v*v,0),1e-10);const k=G*b.mass*(b.gravity??1)*(a.gravity??1)/(r2*Math.sqrt(r2));d.forEach((v,i)=>f[i]+=v*k)}return f});
 let f=forces();bodies.forEach((b,j)=>b.p.forEach((_,i)=>{b.v[i]+=f[j][i]*dt/2;b.p[i]+=b.v[i]*dt}));f=forces();bodies.forEach((b,j)=>b.v.forEach((_,i)=>b.v[i]+=f[j][i]*dt/2));
}
