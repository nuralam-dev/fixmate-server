import {connectDB,closeDB} from '../src/config/db.js';
try {
 const db=await connectDB();
 const name=await db.collection('bookings').createIndex(
  {customerEmail:1,serviceId:1},
  {name:'unique_active_customer_service',unique:true,partialFilterExpression:{status:{$in:['requested','accepted','in-progress']}}}
 );
 console.log(JSON.stringify({database:db.databaseName,index:name}));
} catch {console.error('Booking index setup failed; no records were modified');process.exitCode=1}finally{await closeDB()}
