export const defaultSql = `SELECT order_id, customer_name, amount, status
FROM analytics.orders
WHERE amount > 500
ORDER BY amount DESC
LIMIT 10;`;
const col=(name,type,comment,key=false)=>({name,type,comment,key});
const people=['陈一帆','林晓雨','张子涵','李沐阳','王思远','赵清禾','周亦辰','刘星宇','许若宁','宋予安','黄可欣','吴景行'];
const orders=Array.from({length:24},(_,i)=>({order_id:202610290001+i,customer_name:people[i%12],amount:[1280,599,2399,369,899,1580,459,3280,699,1880,299,1099][i%12]+(i>11?120:0),status:['已完成','已完成','待支付','已完成','已发货','已完成'][i%6],channel:['官网','小程序','App'][i%3],created_at:`2026-10-29 ${String(8+Math.floor(i/6)).padStart(2,'0')}:${String(i*7%60).padStart(2,'0')}:00`}));
export const tables=[
 {db:'analytics',name:'orders',label:'订单明细',model:'Unique Key',total:'12,847,209',size:'28.6 GB',columns:[col('order_id','BIGINT','订单唯一编号',true),col('customer_name','VARCHAR(64)','客户姓名'),col('amount','DECIMAL(12,2)','订单金额（元）'),col('status','VARCHAR(20)','订单状态'),col('channel','VARCHAR(32)','订单渠道'),col('created_at','DATETIME','订单创建时间')],rows:orders},
 {db:'analytics',name:'users',label:'用户信息',model:'Unique Key',total:'1,285,409',size:'3.2 GB',columns:[col('user_id','BIGINT','用户编号',true),col('name','VARCHAR(64)','姓名'),col('city','VARCHAR(32)','所在城市'),col('membership','VARCHAR(20)','会员级别'),col('registered_at','DATE','注册日期')],rows:people.map((p,i)=>({user_id:10001+i,name:p,city:['上海','杭州','北京','深圳'][i%4],membership:['普通会员','黄金会员','铂金会员'][i%3],registered_at:`2026-10-${String(i+1).padStart(2,'0')}`}))},
 {db:'analytics',name:'events',label:'行为事件',model:'Duplicate Key',total:'82,392,540',size:'89.4 GB',columns:[col('event_id','BIGINT','事件编号',true),col('user_id','BIGINT','用户编号'),col('event_type','VARCHAR(32)','事件类型'),col('page','VARCHAR(128)','访问页面'),col('duration_ms','INT','停留时长')],rows:Array.from({length:16},(_,i)=>({event_id:80001+i,user_id:10001+i%12,event_type:['page_view','click','purchase','page_view'][i%4],page:['/home','/products','/checkout','/account'][i%4],duration_ms:1230+i*321}))},
 {db:'warehouse',name:'daily_sales',label:'每日销售汇总',model:'Aggregate Key',total:'36,500',size:'128 MB',columns:[col('sale_date','DATE','统计日期',true),col('channel','VARCHAR(32)','销售渠道',true),col('order_count','BIGINT','订单数量'),col('revenue','DECIMAL(16,2)','销售总额')],rows:Array.from({length:15},(_,i)=>({sale_date:`2026-10-${String(29-Math.floor(i/3)).padStart(2,'0')}`,channel:['官网','小程序','App'][i%3],order_count:1480-i*37,revenue:568290-i*8173}))},
 {db:'warehouse',name:'products',label:'商品维度',model:'Unique Key',total:'48,920',size:'256 MB',columns:[col('product_id','BIGINT','商品编号',true),col('name','VARCHAR(128)','商品名称'),col('category','VARCHAR(32)','商品类别'),col('price','DECIMAL(10,2)','商品价格'),col('stock','INT','剩余库存')],rows:['无线降噪耳机','机械键盘','4K 显示器','便携充电器','智能手表','蓝牙音箱','桌面支架','无线鼠标'].map((p,i)=>({product_id:30001+i,name:p,category:['数码配件','电脑外设'][i%2],price:[899,599,2399,199,1280,459,129,299][i],stock:380-i*23}))},
 {db:'system',name:'audit_log',label:'操作审计',model:'Duplicate Key',total:'4,291,580',size:'6.8 GB',columns:[col('log_id','BIGINT','日志编号',true),col('user','VARCHAR(64)','操作用户'),col('action','VARCHAR(32)','操作类型'),col('database','VARCHAR(64)','数据库'),col('timestamp','DATETIME','操作时间')],rows:Array.from({length:12},(_,i)=>({log_id:90001+i,user:['admin','data_analyst','etl_service'][i%3],action:['SELECT','STREAM_LOAD','SHOW'][i%3],database:['analytics','warehouse'][i%2],timestamp:`2026-10-29 10:${String(58-i*4).padStart(2,'0')}:21`}))}
];
export const nodes=[
 {name:'fe-master-01',ip:'10.0.1.101',role:'FE · Master',cpu:18.2,memory:32.4,uptime:'32 天 18 小时'},
 {name:'fe-follower-02',ip:'10.0.1.102',role:'FE · Follower',cpu:12.8,memory:28.1,uptime:'32 天 18 小时'},
 {name:'be-worker-01',ip:'10.0.2.101',role:'BE · Worker',cpu:42.6,memory:61.8,uptime:'32 天 17 小时'},
 {name:'be-worker-02',ip:'10.0.2.102',role:'BE · Worker',cpu:38.4,memory:56.2,uptime:'32 天 17 小时'},
 {name:'be-worker-03',ip:'10.0.2.103',role:'BE · Worker',cpu:35.7,memory:54.6,uptime:'32 天 17 小时'}
];
export const initialHistory=[
 {id:1,sql:'SELECT * FROM analytics.orders LIMIT 10;',db:'analytics',status:'success',duration:126,count:10,time:'2026/10/29 10:58:21'},
 {id:2,sql:'SELECT COUNT(*) FROM analytics.users;',db:'analytics',status:'success',duration:84,count:1,time:'2026/10/29 10:52:09'},
 {id:3,sql:'SELECT * FROM warehouse.daily_sales LIMIT 5;',db:'warehouse',status:'success',duration:112,count:5,time:'2026/10/29 10:45:32'},
 {id:4,sql:'SHOW DATABASES;',db:'analytics',status:'success',duration:32,count:3,time:'2026/10/29 10:38:05'}
];
export const initialJobs=[
 {id:'job-1001',name:'订单实时同步',source:'Kafka · ecommerce_orders',type:'Routine Load',db:'analytics',status:'RUNNING',progress:86,rows:'12,847,209',time:'2026-10-29 08:00:00'},
 {id:'job-1002',name:'用户行为数据流',source:'Kafka · user_events',type:'Routine Load',db:'analytics',status:'RUNNING',progress:72,rows:'82,392,540',time:'2026-10-29 08:00:00'},
 {id:'job-1003',name:'每日销售报表',source:'S3 · reports/2026-10-28',type:'Broker Load',db:'warehouse',status:'FINISHED',progress:100,rows:'36,500',time:'2026-10-29 02:30:00'},
 {id:'job-1004',name:'商品维度更新',source:'HTTP · products.csv',type:'Stream Load',db:'warehouse',status:'FINISHED',progress:100,rows:'48,920',time:'2026-10-29 04:00:00'}
];

// Deliberately bounded demo evaluator. Unsupported SQL produces an explicit error.
export function evaluateSQL(input,db='analytics'){
 const sql=input.replace(/--[^\n]*/g,'').trim().replace(/;\s*$/,'').trim();
 if(!sql)throw new Error('请输入 SQL 后再运行。');
 if(sql.includes(';'))throw new Error('演示模式每次支持一条 SQL，请分别执行。');
 if(/^SHOW\s+DATABASES$/i.test(sql))return {columns:['Database'],rows:[...new Set(tables.map(t=>t.db))].map(Database=>({Database}))};
 const show=sql.match(/^SHOW\s+TABLES(?:\s+(?:FROM|IN)\s+(\w+))?$/i);
 if(show){const database=show[1]||db;if(!tables.some(t=>t.db===database))throw new Error(`数据库 ${database} 不存在。`);return{columns:['Table'],rows:tables.filter(t=>t.db===database).map(t=>({Table:t.name}))};}
 const describe=sql.match(/^(?:DESC|DESCRIBE)\s+(?:(\w+)\.)?(\w+)$/i);
 if(describe){const t=tables.find(t=>t.db===(describe[1]||db)&&t.name===describe[2]);if(!t)throw new Error('找不到此数据表。');return{columns:['Field','Type','Key','Comment'],rows:t.columns.map(c=>({Field:c.name,Type:c.type,Key:c.key?'YES':'',Comment:c.comment}))};}
 const m=sql.match(/^SELECT\s+(.+?)\s+FROM\s+(?:(\w+)\.)?(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?$/is);
 if(!m)throw new Error('演示支持 SELECT、单条件 WHERE、ORDER BY、LIMIT、COUNT(*)、SHOW DATABASES / TABLES 和 DESC。暂不支持 JOIN、GROUP BY 或写入语句。');
 const table=tables.find(t=>t.db===(m[2]||db)&&t.name===m[3]);if(!table)throw new Error(`找不到数据表 ${(m[2]||db)}.${m[3]}。请从左侧选择一张示例表。`);
 const fields=table.columns.map(c=>c.name);let rows=[...table.rows];
 if(m[4]){const w=m[4].trim().match(/^(\w+)\s*(>=|<=|!=|<>|=|>|<)\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))$/);if(!w)throw new Error("WHERE 仅支持单个字段与数字或单引号字符串比较，例如 amount > 500。");if(!fields.includes(w[1]))throw new Error(`字段 ${w[1]} 不存在。`);const b=w[3]!==undefined?w[3]:Number(w[4]);rows=rows.filter(r=>{const a=r[w[1]];return{'=':()=>a===b,'!=':()=>a!==b,'<>':()=>a!==b,'>':()=>a>b,'<':()=>a<b,'>=':()=>a>=b,'<=':()=>a<=b}[w[2]]()});}
 const count=m[1].match(/^COUNT\(\s*\*\s*\)(?:\s+AS\s+(\w+))?$/i);
 if(count){if(m[5])throw new Error('COUNT(*) 演示不支持 ORDER BY。');const key=count[1]||'COUNT(*)';return{columns:[key],rows:[{[key]:rows.length}]};}
 if(m[5]){if(!fields.includes(m[5]))throw new Error(`排序字段 ${m[5]} 不存在。`);const key=m[5],dir=m[6]?.toUpperCase()==='DESC'?-1:1;rows.sort((a,b)=>(a[key]>b[key]?1:a[key]<b[key]?-1:0)*dir);}
 const columns=m[1].trim()==='*'?fields:m[1].split(',').map(s=>s.trim());
 for(const c of columns)if(!fields.includes(c))throw new Error(`字段 ${c} 不存在；此演示不支持表达式或字段别名。`);
 if(m[7])rows=rows.slice(0,Math.min(Number(m[7]),1000));
 return{columns,rows:rows.map(r=>Object.fromEntries(columns.map(c=>[c,r[c]])))};
}
